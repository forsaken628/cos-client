/**
 * Created by michael on 2017/7/6.
 */
import sqlite3 from 'sqlite3'
let db = new (sqlite3.verbose()).Database('gk.sqlite')

let init = {}

init.config = async function () {
  await new Promise((resolve, reject) => {
    let sqlConfig = `CREATE TABLE IF NOT EXISTS config (
  key   VARCHAR PRIMARY KEY NOT NULL,
  value VARCHAR )`
    db.run(sqlConfig, (err) => {
      err ? reject(err) : resolve()
    })
  })
  return new Promise((resolve, reject) => {
    db.all('SELECT key, value FROM config', (err, rows) => {
      if (err) {
        reject(err)
        return
      }
      let config = {}
      for (let item of rows) {
        config[item.key] = JSON.parse(item.value)
      }
      resolve(config)
    })
  })
}

init.upload = async function () {
  await new Promise((resolve, reject) => {
    let sqlUpload = `CREATE TABLE IF NOT EXISTS upload (
    id INT PRIMARY KEY,
    value VARCHAR )`
    db.run(sqlUpload, (err) => {
      err ? reject(err) : resolve()
    })
  })

  return new Promise((resolve, reject) => {
    db.all('SELECT id, value FROM upload', (err, rows) => {
      if (err) {
        reject(err)
        return
      }
      let arr = []
      for (let row of rows) {
        arr.push(JSON.parse(row.value))
      }
      resolve(arr)
    })
  })
}

init.download = async function () {
  await new Promise((resolve, reject) => {
    let sqlDownload = `CREATE TABLE IF NOT EXISTS download (
    id INT PRIMARY KEY,
    value VARCHAR )`
    db.run(sqlDownload, (err) => {
      err ? reject(err) : resolve()
    })
  })

  return new Promise((resolve, reject) => {
    db.all('SELECT id, value FROM download', (err, rows) => {
      if (err) {
        reject(err)
        return
      }
      let arr = []
      for (let row of rows) {
        arr.push(JSON.parse(row.value))
      }
      resolve(arr)
    })
  })
}

let save = {}

save.config = async function (config) {
  await new Promise((resolve, reject) => {
    db.run(`DELETE FROM config`, (err) => {
      err ? reject(err) : resolve()
    })
  })
  let values = []
  for (let k in config) {
    if (!config.hasOwnProperty(k) || !config[k]) continue
    let j = JSON.stringify(config[k])
    values.push(`('${k}','${j}')`)
  }
  if (values.length === 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    db.run(`INSERT INTO config VALUES ${values.join(',')}`, [], resolve)
  })
}

save.upload = async function (tasks) {
  await new Promise((resolve, reject) => {
    db.run(`DELETE FROM upload`, (err) => {
      err ? reject(err) : resolve()
    })
  })
  let values = []
  for (let t of tasks) {
    if (!t) continue
    let j = JSON.stringify({
      params: t.params,
      name: t.file.fileName,
      status: t.status,
      total: t.progress.total,
      loaded: t.progress.loaded,
      option: {
        asyncLim: t.asyncLim,
        sliceSize: t.file.sliceSize
      }})
    values.push(`(${t.id},'${j}')`)
  }
  if (values.length === 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    db.run(`INSERT INTO upload VALUES ${values.join(',')}`, [], resolve)
  })
}

save.download = async function (tasks) {
  await new Promise((resolve, reject) => {
    db.run(`DELETE FROM download`, (err) => {
      err ? reject(err) : resolve()
    })
  })
  let values = []
  for (let t of tasks) {
    if (!t) continue
    let j = JSON.stringify({
      params: t.params,
      name: t.file.fileName,
      status: t.status,
      total: t.progress.total,
      loaded: t.progress.loaded
    })
    values.push(`(${t.id},'${j}')`)
  }

  if (values.length === 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    db.run(`INSERT INTO download VALUES ${values.join(',')}`, [], resolve)
  })
}

export {init, save, db}
// let stmt = db.prepare('INSERT INTO lorem VALUES (?)')
// for (let i = 0; i < 10; i++) {
//   stmt.run('Ipsum ' + i)
// }
// stmt.finalize()
//
// db.each('SELECT rowid AS id, info FROM lorem', function (err, row) {
//   console.log(row.id + ': ' + row.info)
// })

// db.close()

// function promiseful (fn, self, arg) {
//   return function () {
//     return new Promise((resolve, reject) => {
//       fn.call(self, arg, (err, result) => {
//         err ? reject(err) : resolve(result)
//       })
//     })
//   }
// }
