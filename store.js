import fs from 'fs-extra';
const DB_PATH = './data/db.json';

const defaultDB = {
  users: [],
  items: [],
  history: []
};

export async function loadDB(){
  await fs.ensureFile(DB_PATH);
  const raw = await fs.readFile(DB_PATH, 'utf-8');
  if (!raw.trim()) { await fs.writeFile(DB_PATH, JSON.stringify(defaultDB, null, 2)); return structuredClone(defaultDB); }
  try { return JSON.parse(raw); } catch { return structuredClone(defaultDB); }
}

export async function saveDB(db){
  await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2));
}

export async function transact(mutator){
  const db = await loadDB();
  const result = await mutator(db);
  await saveDB(db);
  return result;
}
