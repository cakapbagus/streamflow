// SESUDAH:
const { db } = require('../db/database');

function getOverlaySettings(userId) {
  return db.prepare('SELECT * FROM overlay_settings WHERE user_id = ?').get(userId);
}

function saveOverlaySettings(userId, settings) {
  const existing = getOverlaySettings(userId);
  
  if (existing) {
    db.prepare(`
      UPDATE overlay_settings 
      SET enabled = ?, image_path = ?, position_x = ?, position_y = ?, 
          width = ?, height = ?, opacity = ?, updated_at = datetime('now')
      WHERE user_id = ?
    `).run(
      settings.enabled ? 1 : 0,
      settings.image_path,
      settings.position_x,
      settings.position_y,
      settings.width,
      settings.height,
      settings.opacity,
      userId
    );
  } else {
    db.prepare(`
      INSERT INTO overlay_settings 
      (user_id, enabled, image_path, position_x, position_y, width, height, opacity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      settings.enabled ? 1 : 0,
      settings.image_path ?? null,
      settings.position_x ?? 10,
      settings.position_y ?? 10,
      settings.width ?? 150,
      settings.height ?? 150,
      settings.opacity ?? 1.0
    );
  }
  
  return getOverlaySettings(userId);
}

module.exports = { getOverlaySettings, saveOverlaySettings };