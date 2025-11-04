const db = require('../config/db');

module.exports.requireAuth = (req, res, next) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ message: 'Bejelentkezés szükséges.' });
  }
  next();
};

module.exports.requireAdmin = async (req, res, next) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ message: 'Bejelentkezés szükséges.' });
  }

  if (req.session.role === 'admin') {
    return next();
  }

  try {
    const [[user]] = await db.query(
      'SELECT FUNKCIO FROM userek WHERE ID_USER = ? LIMIT 1',
      [req.session.userId]
    );

    if (!user) {
      return res.status(401).json({ message: 'Felhasználó nem található.' });
    }

    const isAdmin = Number(user.FUNKCIO) === 1;
    req.session.role = isAdmin ? 'admin' : 'user';

    if (!isAdmin) {
      return res.status(403).json({ message: 'Nincs jogosultság a művelethez.' });
    }

    next();
  } catch (err) {
    console.error('Hiba a jogosultság ellenőrzésekor:', err);
    res.status(500).json({ message: 'Nem sikerült ellenőrizni a jogosultságot.' });
  }
};
