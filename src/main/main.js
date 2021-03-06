/**
 * Created by michael on 2017/6/29.
 */
'use strict'
import fs from 'fs'
import path from 'path'
import { ipcMain } from 'electron'
import log from 'electron-log'
import promisify from 'util.promisify'
import Cos from 'cos-nodejs-sdk-v5'
import { DownloadTask, Tasks, UploadTask } from './task'
import DB from './db'

log.transports.console.level = false
log.transports.file.level = 'warn'
log.transports.rendererConsole.level = 'silly'

let main

/**
 * 单例类，在应用初始化时初始化config，在窗口创建时初始化uploads和downloads，
 * 窗口关闭时config，uploads，downloads记录数据库，但不清除。
 */
function Main () {
  if (main) return main
  main = this
  main.init().catch(err => {
    log.error(err)
  })
}

Main.prototype.init = async function () {
  let db = new DB()
  /** @type {Tasks} */
  let uploads
  /** @type {Tasks} */
  let downloads

  let config = await db.config().get()
  config.upload = config.upload || {maxActivity: 3, asyncLim: 2}
  config.download = config.download || {maxActivity: 3}

  uploads = new Tasks(config.upload.maxActivity)

  let uploadsIsInit = false

  let uploadSenders = []

  function uploadListen (uploads) {
    uploads.on('done', (task, result) => {
      task.progress.loaded = task.progress.total
      log.info(`upload ${task.params.Bucket}/${task.params.Key} done`)
    })

    uploads.on('cancel', (task, result) => {
      log.info(`upload ${task.params.Bucket}/${task.params.Key} cancel`)
    })

    uploads.on('error', (task, err) => {
      log.error(`upload ${task.params.Bucket}/${task.params.Key} error`, err)
    })

    uploads.on('refresh', (data) => {
      for (let sender of uploadSenders) {
        if (sender && !sender.isDestroyed()) sender.send('GetUploadTasks-data', data)
      }
    })
  }

  uploadListen(uploads)

  ipcMain.on('GetUploadTasks', (event) => {
    if (uploadSenders[event.sender.id]) {
      uploads.refresh()
      return
    }

    uploadSenders[event.sender.id] = event.sender

    event.sender.on('closed', () => {
      delete uploadSenders[event.sender.id]
    })

    uploads.refresh()
  })

  downloads = new Tasks(config.download.maxActivity)

  let downloadsIsInit = false

  let downloadSenders = []

  function downloadListen (downloads) {
    downloads.on('done', (task, result) => {
      task.progress.loaded = task.progress.total
      log.info(`download done ${task.params.Bucket}/${task.params.Key}`)
    })

    downloads.on('cancel', (task, result) => {
      log.info(`download cancel ${task.params.Bucket}/${task.params.Key}`)
    })

    downloads.on('error', (task, err) => {
      log.info(`download error ${task.params.Bucket}/${task.params.Key} `, err)
    })

    downloads.on('refresh', (data) => {
      for (let sender of downloadSenders) {
        if (sender && !sender.isDestroyed()) sender.send('GetDownloadTasks-data', data)
      }
    })
  }

  downloadListen(downloads)

  ipcMain.on('GetDownloadTasks', (event) => {
    if (downloadSenders[event.sender.id]) {
      downloads.refresh()
      return
    }

    downloadSenders[event.sender.id] = event.sender

    event.sender.on('closed', () => {
      delete downloadSenders[event.sender.id]
    })

    downloads.refresh()
  })

  let cos

  ipcMain.on('GetConfig', (event) => {
    if (config.cos) {
      cos = new Cos(config.cos)
    }
    event.returnValue = config
  })

  ipcMain.on('SetConfig', (event, cfg) => {
    /**
     * @param {object}  cfg
     * @param {object}  cfg.cos
     * @param {object}  cfg.upload
     * @param {int}     cfg.upload.maxActivity
     * @param {int}     cfg.upload.asyncLim
     * @param {object}  cfg.download
     * @param {int}     cfg.download.maxActivity
     */
    config = cfg
    cos = new Cos(cfg.cos)
    // 修改最大并行任务数，当任务数增加时会自动启动新任务，减少时不会立即停止当前运行的任务，而是在当前任务完成后调整
    if (cfg.upload) uploads.maxLim(cfg.upload.maxActivity)
    if (cfg.download) downloads.maxLim(cfg.upload.maxActivity)

    if (uploadsIsInit && downloadsIsInit) return

    (async () => {
      if (uploadsIsInit) return Promise.resolve()
      uploadsIsInit = true
      let tasks = await db.upload().get()
      for (let t of tasks) {
        try {
          let task = await new UploadTask(cos, t.name, t.params, t.option)
          uploads.newTask(task)
          task.progress.loaded = t.loaded
          task.progress.total = t.total
          task.status = t.status
        } catch (err) {
          log.error(err)
        }
      }
    })().catch(err => log.error(err));

    (async () => {
      if (downloadsIsInit) return Promise.resolve()
      downloadsIsInit = true
      let tasks = await db.download().get()
      for (let t of tasks) {
        try {
          let task = await new DownloadTask(cos, t.name, t.params, t.option)
          downloads.newTask(task)
          task.progress.loaded = t.loaded
          task.progress.total = t.total
          task.status = t.status
        } catch (e) {
          log.error(e)
        }
      }
    })().catch(err => log.error(err))
  })

  ipcMain.on('GetLogPath', (event) => {
    event.returnValue = log.transports.file.findLogPath(log.transports.file.appName)
  })

  // 只能在绑定推送前调用
  ipcMain.on('ClearAll', () => {
    config = {
      upload: {maxActivity: 3, asyncLim: 2},
      download: config.download || {maxActivity: 3},
      logPath: log.transports.file.findLogPath(log.transports.file.appName)
    }
    uploads = new Tasks(config.upload.maxActivity)

    uploadListen(uploads)

    downloads = new Tasks(config.download.maxActivity)

    downloadListen(downloads)

    db.clear()
  })

  ipcMain.on('NewUploadTasks', async (event, arg) => {
    /**
     * @param  {object}   arg
     * @param  {string}   arg.Bucket
     * @param  {string}   arg.Region
     * @param  {string}   arg.Prefix
     * @param  {string[]} arg.FileNames
     */
    for (let name of arg.FileNames) {
      for (let item of uploadGenerator(name, arg.Prefix)) {
        try {
          if (item.isDir) {
            promisify(::cos.putObject)({
              Bucket: arg.Bucket,
              Region: arg.Region,
              Key: item.key,
              Body: Buffer.from('')
            })
            continue
          }
          let task = await new UploadTask(cos, item.name, {
            Bucket: arg.Bucket,
            Region: arg.Region,
            Key: item.key
          }, {asyncLim: config.upload.asyncLim})
          uploads.newTask(task)
        } catch (err) {
          log.error(err)
        }
        uploads.next()
      }
    }
    uploads.refresh()
  })

  ipcMain.on('PauseUploadTasks', (event, arg) => {
    /**
     * @param {object}  arg
     * @param {int[]}   arg.tasks
     * @param {boolean} arg.all
     * @param {boolean} arg.wait
     */
    uploads.pause(arg.tasks, arg.all, arg.wait)
  })

  ipcMain.on('ResumeUploadTask', (event, arg) => {
    /**
     * @param {object}  arg
     * @param {int[]}   arg.tasks
     * @param {boolean} arg.all
     */
    uploads.resume(arg.tasks, arg.all)
  })

  ipcMain.on('DeleteUploadTasks', (event, arg) => {
    /**
     * @param {object}  arg
     * @param {int[]}   arg.tasks
     * @param {boolean} arg.all
     * @param {boolean} arg.onlyComplete
     * @param {boolean} arg.onlyNotComplete
     */
    uploads.delete(arg.tasks, arg.all, arg.onlyComplete, arg.onlyNotComplete)
  })

  ipcMain.on('NewDownloadTasks', async (event, arg) => {
    /**
     * @param  {object}    arg
     * @param  {string}    arg.Bucket
     * @param  {string}    arg.Region
     * @param  {string}    arg.Path     本地路径
     * @param  {string}    arg.Prefix   远程路径
     * @param  {string[]}  [arg.Keys]   文件下载
     * @param  {string[]}  [arg.Dirs]   文件夹下载
     */
    let params = {
      Bucket: arg.Bucket,
      Region: arg.Region
    }

    async function fn (contents) {
      for (let item of downloadGenerator(arg.Path, arg.Prefix, contents)) {
        try {
          let task = await new DownloadTask(cos, item.name, {
            Bucket: arg.Bucket,
            Region: arg.Region,
            Key: item.key
          })
          downloads.newTask(task)
          downloads.next()
        } catch (err) {
          log.error(err)
        }
      }
    }

    if (arg.Keys) {
      await fn(arg.Keys.map(k => ({Key: k})))
    }

    for (let dir of arg.Dirs) {
      params.Prefix = dir
      let result
      do {
        result = await getBucket(cos, params)
        await fn(result.Contents)
        params.Marker = result.NextMarker
      } while (result.IsTruncated === 'true')
    }
    downloads.refresh()
  })

  ipcMain.on('PauseDownloadTasks', (event, arg) => {
    /**
     * @param {object}  arg
     * @param {int[]}   arg.tasks
     * @param {boolean} arg.all
     * @param {boolean} arg.wait
     */
    downloads.pause(arg.tasks, arg.all, arg.wait)
  })

  ipcMain.on('ResumeDownloadTask', (event, arg) => {
    /**
     * @param {object}  arg
     * @param {int[]}   arg.tasks
     * @param {boolean} arg.all
     */
    downloads.resume(arg.tasks, arg.all)
  })

  ipcMain.on('DeleteDownloadTasks', (event, arg) => {
    /**
     * @param {object}  arg
     * @param {int[]}   arg.tasks
     * @param {boolean} arg.all
     * @param {boolean} arg.onlyComplete
     * @param {boolean} arg.onlyNotComplete
     */
    downloads.delete(arg.tasks, arg.all, arg.onlyComplete, arg.onlyNotComplete)
  })

  this.close = function () {
    if (!uploads || !downloads) return Promise.resolve()
    uploads.pause([], true)
    downloads.pause([], true)
    let cfg = Object.assign({}, config)
    delete cfg.cos
    return Promise.all([
      db.config().set(cfg),
      db.upload().set(uploads.tasks),
      db.download().set(downloads.tasks)
    ])
  }
}

// 前缀如果是根目录，必须传入''，否则必须以'／'结尾
function* uploadGenerator (name, prefix) {
  let src = []
  name = path.normalize(name)
  let p = path.parse(name)

  if (!fs.statSync(name).isDirectory()) {
    yield {name, key: prefix + p.base, isDir: false}
    return
  }

  if (p.base) {
    yield {name, key: prefix + p.base + '/', isDir: true}
  } else {
    prefix += p.root === '/' ? 'root/' : p.root.split(':')[0] + '/'
    yield {name, key: prefix, isDir: true}
  }

  // 可以正确处理 'c:\\', '/'等根路径, 但不能处理'c:'
  let dirLen = p.root === p.dir ? p.dir.length : p.dir.length + 1
  let dir = name
  do {
    let subsrc = []
    for (let name of fs.readdirSync(dir)) {
      name = path.join(dir, name)
      if (fs.statSync(name).isDirectory()) {
        subsrc.unshift(name)
        yield {name, key: prefix + name.substr(dirLen).replace(/\\/g, '/') + '/', isDir: true}
        continue
      }
      yield {name, key: prefix + name.substr(dirLen).replace(/\\/g, '/'), isDir: false}
    }
    src.push(...subsrc)
    dir = src.pop()
  } while (dir)
}

function* downloadGenerator (downloadPath, prefix, contents) {
  if (prefix !== '') {
    prefix = prefix.substr(-1) === '/' ? prefix : prefix + '/'
  }
  let pflen = prefix.length
  for (let content of contents) {
    if (content.Key.substr(-1) === '/') continue
    yield {
      name: path.join(downloadPath, content.Key.substr(pflen)),
      key: content.Key
    }
  }
}

function getBucket (cos, params) {
  return new Promise((resolve, reject) => {
    cos.getBucket(params, (err, data) => {
      err ? reject(err) : resolve(data)
    })
  })
}

export default Main
