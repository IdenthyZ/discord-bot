// Configuración de conexión a SQLite para el sistema RPG
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'rpg.sqlite');
const db = new sqlite3.Database(dbPath);

// Crear tablas si no existen
function initRPGDatabase() {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT,
      coins INTEGER DEFAULT 0,
      wood INTEGER DEFAULT 0,
      stone INTEGER DEFAULT 0,
      iron INTEGER DEFAULT 0,
      job TEXT DEFAULT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS inventory (
      user_id TEXT,
      item TEXT,
      quantity INTEGER,
      PRIMARY KEY (user_id, item)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS market (
      item TEXT,
      price INTEGER,
      stock INTEGER
    )`);
  });
}

module.exports = { db, initRPGDatabase };