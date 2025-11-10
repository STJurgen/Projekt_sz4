const bcrypt = require('bcrypt');
const User = require('../models/User');
const transporter = require('../config/mailer');
const db = require('../config/db');

// 6 számjegyű kód generálás
function generateVerificationCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// 1️⃣ Regisztráció – csak email + jelszó kell
exports.register = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'E-mail és jelszó kötelező!' });
    }

    const code = generateVerificationCode();
    req.session.verificationCode = code;
    req.session.email = email;
    req.session.password = password;

    await transporter.sendMail({
      from: process.env.FROM_DEFAULT,
      to: email,
      subject: 'Regisztráció megerősítése',
      html: `<h3>Megerősítő kód:</h3><p><b>${code}</b></p>`
    });

    res.json({ message: 'Megerősítő kód kiküldve az email címedre!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Hiba történt a regisztráció során.' });
  }
};

// 2️⃣ Kód ellenőrzése + user mentés DB-be
exports.verifyCode = async (req, res) => {
  const { code, nev, telefon, telepules, cim, login } = req.body;

  if (req.session.verificationCode === code && req.session.email) {
    if (!nev || !telefon || !telepules || !cim || !login) {
      return res.status(400).json({ message: 'Minden adat kötelező a regisztrációhoz!' });
    }

    try {
      const hashedPassword = await bcrypt.hash(req.session.password, 10);

      const userId = await User.create({
        nev,
        telefon,
        email: req.session.email,
        password: hashedPassword,
        telepules,
        cim,
        login
      });

      req.session.destroy(() => {});
      return res.json({ message: 'Sikeres regisztráció!', userId });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: 'Hiba a mentés során.' });
    }
  }

  res.status(400).json({ message: 'Hibás kód!' });
};

// 3️⃣ Bejelentkezés
exports.login = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'E-mail és jelszó kötelező!' });
  }

  try {
    const [[userRows], [operatorRows]] = await Promise.all([
      db.query(`SELECT * FROM userek WHERE EMAIL = ? LIMIT 1`, [email]),
      db.query(`SELECT * FROM operator WHERE EMAIL = ? LIMIT 1`, [email])
    ]);

    const user = userRows[0];
    const operator = operatorRows[0];

    // Ha egyik sem található:
    if (!user && !operator) {
      return res.status(400).json({ message: 'Nincs ilyen felhasználó!' });
    }

    // Jelszóellenőrzés külön-külön
    let match = false;
    let loggedInUser = null;
    let role = null;

    if (user && await bcrypt.compare(password, user.PASSWORD)) {
      match = true;
      loggedInUser = user;
      role = 'user';
    } else if (operator && operator.PASSWORD === password) {
      match = true;
      loggedInUser = operator;
      role = operator.ADMIN === 'Y' ? 'admin' : 'operator';
    }
    
    

    if (!match) {
      return res.status(400).json({ message: 'Hibás jelszó!' });
    }

    // Azonosító beállítása
    const userId = loggedInUser.ID_USER || loggedInUser.ID_OPERATOR || loggedInUser.id || loggedInUser.ID;

    // Session beállítása
    req.session.userId = userId;
    req.session.email = loggedInUser.EMAIL;
    req.session.role = role;

    res.json({
      message: 'Sikeres bejelentkezés!',
      userId,
      role
    });

  } catch (err) {
    console.error('Bejelentkezési hiba:', err);
    res.status(500).json({ message: 'Hiba a bejelentkezés során.' });
  }
};

// 4️⃣ Profil lekérése (userek + operator kezeléssel)
exports.getProfile = async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ message: "Nincs bejelentkezve!" }); //szia
  }

  try {
    let rows;

    if (req.session.role === 'operator' || req.session.role === 'admin') {
      // 🔹 Operátor vagy admin esetén az operator táblából kérdezünk
      [rows] = await db.query(
        `SELECT ID_OPERATOR AS ID_OPERATOR, LOGIN, NEV, ADMIN, EMAIL
         FROM operator 
         WHERE ID_OPERATOR = ? 
         LIMIT 1`,
        [req.session.userId]
      );
    } else {
      // 🔹 Normál user esetén a userek táblából
      [rows] = await db.query(
        `SELECT u.ID_USER AS id, u.NEV, u.LOGIN, u.EMAIL, u.TELEFON, u.CIM,
                u.ID_TELEPULES, t.TELEPULES, t.IRSZAM, m.MEGYE,
                u.CEGNEV, u.ADOSZAM, u.CIM_SZML, u.FUNKCIO, u.RATIFICAT
         FROM userek u
         LEFT JOIN telepulesek t ON u.ID_TELEPULES = t.ID_TELEPULES
         LEFT JOIN megye m ON t.ID_MEGYEK = m.ID_MEGYEK
         WHERE u.ID_USER = ? 
         LIMIT 1`,
        [req.session.userId]
      );
    }

    if (!rows || rows.length === 0) {
      return res.status(404).json({ message: "Felhasználó nem található!" });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('Profil lekérési hiba:', err);
    res.status(500).json({ message: "Hiba történt a profil lekérésekor." });
  }
};


// 5️⃣ Profil frissítése
exports.updateProfile = async (req, res) => {
  const { login, telefon, cim, cegnev, adoszam, cim_szml } = req.body;

  if (!req.session.userId) {
    return res.status(401).json({ message: "Nincs bejelentkezve!" });
  }

  try {
    await db.query(
      `UPDATE userek SET LOGIN = ?, TELEFON = ?, CIM = ?, CEGNEV = ?, ADOSZAM = ?, CIM_SZML = ? WHERE ID_USER = ?`,
      [login, telefon, cim, cegnev, adoszam, cim_szml, req.session.userId]
    );
    res.json({ message: "Profil sikeresen frissítve!" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Hiba történt a profil frissítésekor." });
  }
};

// 6️⃣ Kijelentkezés
exports.logout = async (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error(err);
      return res.status(500).json({ message: "Hiba a kijelentkezés során." });
    }
    res.json({ message: "Sikeres kijelentkezés!" });
  });
};

// 7️⃣ Rendelés hozzáadása
exports.addOrder = async (req, res) => {
  const { szallmod, fizmod, leiras } = req.body;

  if (!szallmod || !fizmod || !leiras) {
    return res.status(400).json({ message: "Minden mező kitöltése kötelező!" });
  }

  if (!req.session.userId) {
    return res.status(401).json({ message: "Nincs bejelentkezve!" });
  }

  try {
    const [result] = await db.query(
      `INSERT INTO szerviz_kosar (ID_USER, SZALLMOD, FIZMOD, LEIRAS, DATUMIDO) VALUES (?, ?, ?, ?, NOW())`,
      [req.session.userId, szallmod, fizmod, leiras]
    );

    res.status(201).json({
      id: result.insertId,
      szallmod,
      fizmod,
      leiras,
      datum: new Date().toISOString()
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Hiba történt a rendelés hozzáadásakor." });
  }
};

// 8️⃣ Saját rendelések lekérése (statusz nélkül)
exports.getOrders = async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ message: "Nincs bejelentkezve!" });
  }

  try {
    const [rows] = await db.query(
      `SELECT ID_KOSAR, SZALLMOD, FIZMOD, LEIRAS, DATUMIDO
       FROM szerviz_kosar
       WHERE ID_USER = ?
       ORDER BY DATUMIDO DESC`,
      [req.session.userId] // <-- csak a bejelentkezett user saját adatai
    );

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Hiba történt a rendelések lekérésekor." });
  }
};


// 9️⃣ Rendelés törlése – MySQL szinten számoljuk az eltelt időt
exports.deleteOrder = async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ message: "Nincs bejelentkezve!" });
  }

  const { id } = req.params;
  if (!id) {
    return res.status(400).json({ message: "Hiányzó rendelés azonosító!" });
  }

  try {
    // Ellenőrizzük, hogy a rendelés a felhasználóé-e és mennyi idő telt el MySQL szinten
    const [rows] = await db.query(
      `
      SELECT 
        ID_KOSAR,
        TIMESTAMPDIFF(HOUR, DATUMIDO, NOW()) AS elapsed_hours
      FROM szerviz_kosar
      WHERE ID_KOSAR = ? AND ID_USER = ?
      `,
      [id, req.session.userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Rendelés nem található!" });
    }

    const elapsed = rows[0].elapsed_hours;

    if (elapsed > 2) {
      return res.status(403).json({ message: "A rendelés már nem törölhető (2 órán túl)!" });
    }

    // Ha 2 órán belül van, töröljük
    await db.query(
      `DELETE FROM szerviz_kosar WHERE ID_KOSAR = ? AND ID_USER = ?`,
      [id, req.session.userId]
    );

    res.json({ message: "✅ Rendelés sikeresen törölve!" });
  } catch (err) {
    console.error("❌ Hiba a rendelés törlésekor:", err);
    res.status(500).json({ message: "Hiba történt a rendelés törlésekor." });
  }
  };

  // 🔟 Profil irányító – közös hivatkozási pont minden szerepkörnek
  exports.redirectProfile = async (req, res) => {
    try {
      if (!req.session.userId || !req.session.role) {
        // Nincs bejelentkezve → login oldal
        return res.redirect('/login.html');
      }

      switch (req.session.role) {
        case 'user':
          return res.redirect('/profil.html');
        case 'operator':
          return res.redirect('/employee.html');
        case 'admin':
          return res.redirect('/admin.html');
        default:
          return res.redirect('/login.html');
      }
    } catch (err) {
      console.error('Hiba a profil irányításnál:', err);
      res.status(500).send('Hiba történt az irányítás során.');
    }
  };

