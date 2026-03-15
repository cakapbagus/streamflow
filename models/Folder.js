const { db } = require('../db/database');
const fs = require('fs');
const path = require('path');

class Folder {
  /**
   * Buat tabel folders jika belum ada.
   * Dipanggil dari initializeDatabase() di db/database.js
   */
  static createTable() {
    return new Promise((resolve, reject) => {
      db.run(
        `CREATE TABLE IF NOT EXISTS folders (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          name      TEXT    NOT NULL,
          parent_id INTEGER DEFAULT NULL,
          user_id   INTEGER NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE,
          FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE CASCADE
        )`,
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  /** Ambil semua folder milik user */
  static findAll(userId) {
    return new Promise((resolve, reject) => {
      db.all(
        'SELECT * FROM folders WHERE user_id = ? ORDER BY name ASC',
        [userId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
  }

  /** Ambil satu folder by id */
  static findById(id) {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM folders WHERE id = ?', [id], (err, row) => {
        if (err) reject(err);
        else resolve(row || null);
      });
    });
  }

  /** Buat folder baru */
  static create({ name, parent_id = null, user_id }) {
    return new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO folders (name, parent_id, user_id) VALUES (?, ?, ?)',
        [name, parent_id || null, user_id],
        function (err) {
          if (err) reject(err);
          else resolve({ id: this.lastID, name, parent_id: parent_id || null, user_id });
        }
      );
    });
  }

  /** Rename folder */
  static update(id, { name }) {
    return new Promise((resolve, reject) => {
      db.run(
        'UPDATE folders SET name = ? WHERE id = ?',
        [name, id],
        function (err) {
          if (err) reject(err);
          else resolve({ id, name });
        }
      );
    });
  }

  /**
   * Hapus folder beserta seluruh subfolder-nya (rekursif)
   * dan semua file di dalamnya (set folder_id = NULL atau delete file)
   */
  static async deleteRecursive(id, userId) {
    // Kumpulkan semua subfolder id secara rekursif
    const allFolderIds = await Folder._collectSubfolderIds(id);
    allFolderIds.push(id);

    const placeholders = allFolderIds.map(() => '?').join(',');

    // 1. Ambil semua video yang ada di folder-folder tersebut
    const videos = await new Promise((resolve, reject) => {
      db.all(
        `SELECT id, filepath, thumbnail_path FROM videos
         WHERE folder_id IN (${placeholders}) AND user_id = ?`,
        [...allFolderIds, userId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    // 2. Hapus file fisik dari disk (video + thumbnail)
    const publicDir = path.join(__dirname, '..', 'public');
    for (const video of videos) {
      try {
        if (video.filepath) {
          const videoPath = path.join(publicDir, video.filepath);
          if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
        }
      } catch (e) {
        console.error(`Error deleting video file (id=${video.id}):`, e.message);
      }
      try {
        if (video.thumbnail_path) {
          const thumbPath = path.join(publicDir, video.thumbnail_path);
          if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
        }
      } catch (e) {
        console.error(`Error deleting thumbnail (id=${video.id}):`, e.message);
      }
    }

    // 3. Hapus record video dari database
    await new Promise((resolve, reject) => {
      db.run(
        `DELETE FROM videos WHERE folder_id IN (${placeholders}) AND user_id = ?`,
        [...allFolderIds, userId],
        (err) => {
          if (err) { console.error('Error deleting videos in folders:', err); reject(err); }
          else resolve();
        }
      );
    });

    // 4. Hapus semua subfolder lalu folder utama
    const deleteSubfolders = allFolderIds
      .filter(fid => fid !== id)
      .map(fid => new Promise((res, rej) => {
        db.run('DELETE FROM folders WHERE id = ? AND user_id = ?', [fid, userId], (e) => {
          if (e) rej(e); else res();
        });
      }));

    await Promise.all(deleteSubfolders);

    return new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM folders WHERE id = ? AND user_id = ?',
        [id, userId],
        function (err) {
          if (err) reject(err);
          else resolve({ deleted: this.changes > 0, folderIds: allFolderIds });
        }
      );
    });
  }

  /** Kumpulkan semua id subfolder secara rekursif */
  static _collectSubfolderIds(parentId) {
    return new Promise((resolve, reject) => {
      db.all(
        'SELECT id FROM folders WHERE parent_id = ?',
        [parentId],
        async (err, rows) => {
          if (err) return reject(err);
          if (!rows || rows.length === 0) return resolve([]);

          try {
            const childIds = rows.map(r => r.id);
            const nestedIds = await Promise.all(
              childIds.map(cid => Folder._collectSubfolderIds(cid))
            );
            resolve([...childIds, ...nestedIds.flat()]);
          } catch (e) {
            reject(e);
          }
        }
      );
    });
  }
}

module.exports = Folder;