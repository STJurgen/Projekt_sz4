const db = require('../config/db');
const transporter = require('../config/mailer');

const STATUS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS admin_order_status (
    ID_KOSAR INT PRIMARY KEY,
    STATUSZ ENUM('pending','accepted','rejected') NOT NULL DEFAULT 'pending',
    MEGJEGYZES TEXT,
    UPDATED_AT DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_admin_order_status_kosar
      FOREIGN KEY (ID_KOSAR) REFERENCES szerviz_kosar(ID_KOSAR)
      ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

const statusTableReady = db.query(STATUS_TABLE_SQL).catch(err => {
  console.error('Nem sikerült létrehozni az admin_order_status táblát:', err);
});

async function ensureStatusTable() {
  await statusTableReady;
}

exports.getOrders = async (req, res) => {
  try {
    await ensureStatusTable();

    const [rows] = await db.query(
      `SELECT k.ID_KOSAR, k.ID_USER, k.SZALLMOD, k.FIZMOD, k.LEIRAS, k.DATUMIDO,
              u.NEV AS UGYFEL_NEV, u.EMAIL AS UGYFEL_EMAIL,
              COALESCE(s.STATUSZ, 'pending') AS STATUSZ,
              s.MEGJEGYZES,
              s.UPDATED_AT
       FROM szerviz_kosar k
       JOIN userek u ON u.ID_USER = k.ID_USER
       LEFT JOIN admin_order_status s ON s.ID_KOSAR = k.ID_KOSAR
       ORDER BY k.DATUMIDO DESC`
    );

    res.json(rows);
  } catch (err) {
    console.error('Hiba a rendelések lekérésekor:', err);
    res.status(500).json({ message: 'Hiba a rendelések lekérésekor.' });
  }
};

exports.updateOrderStatus = async (req, res) => {
  const { orderId } = req.params;
  const { status, note } = req.body;

  if (!['accepted', 'rejected', 'pending'].includes(status)) {
    return res.status(400).json({ message: 'Érvénytelen státusz.' });
  }

  try {
    await ensureStatusTable();

    const [result] = await db.query(
      `INSERT INTO admin_order_status (ID_KOSAR, STATUSZ, MEGJEGYZES)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE STATUSZ = VALUES(STATUSZ), MEGJEGYZES = VALUES(MEGJEGYZES)`
      , [orderId, status, note || null]
    );

    if (!result.affectedRows) {
      return res.status(404).json({ message: 'Rendelés nem található.' });
    }

    res.json({ message: 'Státusz frissítve.' });
  } catch (err) {
    console.error('Hiba a státusz frissítésekor:', err);
    res.status(500).json({ message: 'Hiba a státusz frissítésekor.' });
  }
};

exports.sendMessage = async (req, res) => {
  const { userId, subject, message } = req.body;

  if (!userId || !message) {
    return res.status(400).json({ message: 'Felhasználó és üzenet megadása kötelező.' });
  }

  try {
    const [[user]] = await db.query(
      'SELECT EMAIL, NEV FROM userek WHERE ID_USER = ? LIMIT 1',
      [userId]
    );

    if (!user) {
      return res.status(404).json({ message: 'Felhasználó nem található.' });
    }

    await transporter.sendMail({
      to: user.EMAIL,
      from: process.env.FROM_DEFAULT,
      subject: subject || 'PROCOMP üzenet',
      html: `<p>Kedves ${user.NEV || 'Ügyfelünk'},</p><p>${message.replace(/\n/g, '<br>')}</p><p>Üdvözlettel:<br>PROCOMP csapat</p>`
    });

    res.json({ message: 'Üzenet elküldve.' });
  } catch (err) {
    console.error('Hiba az üzenet küldésekor:', err);
    res.status(500).json({ message: 'Hiba az üzenet küldésekor.' });
  }
};

exports.getUsers = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT ID_USER, NEV, EMAIL, TELEFON, FUNKCIO
       FROM userek
       ORDER BY NEV ASC`
    );

    res.json(rows);
  } catch (err) {
    console.error('Hiba a felhasználók lekérésekor:', err);
    res.status(500).json({ message: 'Hiba a felhasználók lekérésekor.' });
  }
};

exports.updateUserRole = async (req, res) => {
  const { userId } = req.params;
  const { isAdmin } = req.body;

  const funkcio = isAdmin ? 1 : 0;

  try {
    const [result] = await db.query(
      'UPDATE userek SET FUNKCIO = ? WHERE ID_USER = ?',
      [funkcio, userId]
    );

    if (req.session.userId === Number(userId)) {
      req.session.role = funkcio === 1 ? 'admin' : 'user';
    }

    if (!result.affectedRows) {
      return res.status(404).json({ message: 'Felhasználó nem található.' });
    }

    res.json({ message: 'Jogosultság frissítve.' });
  } catch (err) {
    console.error('Hiba a jogosultság frissítésekor:', err);
    res.status(500).json({ message: 'Hiba a jogosultság frissítésekor.' });
  }
};

exports.deleteUser = async (req, res) => {
  const { userId } = req.params;

  if (req.session.userId === Number(userId)) {
    return res.status(400).json({ message: 'Saját fiók nem törölhető.' });
  }

  let connection;

  try {
    await ensureStatusTable();
    connection = await db.getConnection();
    await connection.beginTransaction();

    await connection.query(
      'DELETE FROM admin_order_status WHERE ID_KOSAR IN (SELECT ID_KOSAR FROM szerviz_kosar WHERE ID_USER = ?)',
      [userId]
    );

    await connection.query(
      'DELETE FROM szerviz_kosar_tetelei WHERE ID_KOSAR IN (SELECT ID_KOSAR FROM szerviz_kosar WHERE ID_USER = ?)',
      [userId]
    );

    await connection.query('DELETE FROM szerviz_kosar WHERE ID_USER = ?', [userId]);

    const [result] = await connection.query('DELETE FROM userek WHERE ID_USER = ?', [userId]);

    if (!result.affectedRows) {
      await connection.rollback();
      return res.status(404).json({ message: 'Felhasználó nem található.' });
    }

    await connection.commit();
    res.json({ message: 'Felhasználó törölve.' });
  } catch (err) {
    if (connection) {
      await connection.rollback();
    }
    console.error('Hiba a felhasználó törlésekor:', err);
    res.status(500).json({ message: 'Hiba a felhasználó törlésekor.' });
  } finally {
    if (connection) connection.release();
  }
};

exports.runCommand = async (req, res) => {
  const { command } = req.body;

  if (!command) {
    return res.status(400).json({ message: 'Parancs megadása szükséges.' });
  }

  try {
    const normalized = command.trim().toLowerCase();

    switch (normalized) {
      case 'stats': {
        await ensureStatusTable();
        const [[ordersCount]] = await db.query('SELECT COUNT(*) AS osszes FROM szerviz_kosar');
        const [[pending]] = await db.query(
          `SELECT COUNT(*) AS db FROM szerviz_kosar k
            LEFT JOIN admin_order_status s ON s.ID_KOSAR = k.ID_KOSAR
            WHERE COALESCE(s.STATUSZ, 'pending') = 'pending'`
        );
        const [[accepted]] = await db.query(
          `SELECT COUNT(*) AS db FROM admin_order_status WHERE STATUSZ = 'accepted'`
        );
        const [[rejected]] = await db.query(
          `SELECT COUNT(*) AS db FROM admin_order_status WHERE STATUSZ = 'rejected'`
        );

        return res.json({
          output: `Összes rendelés: ${ordersCount.osszes}\nFüggőben: ${pending.db}\nElfogadva: ${accepted.db}\nElutasítva: ${rejected.db}`
        });
      }
      case 'latest user': {
        const [[lastUser]] = await db.query(
          'SELECT NEV, EMAIL FROM userek ORDER BY ID_USER DESC LIMIT 1'
        );

        if (!lastUser) {
          return res.json({ output: 'Még nincs regisztrált felhasználó.' });
        }

        return res.json({
          output: `Legutóbbi felhasználó: ${lastUser.NEV || lastUser.EMAIL} (${lastUser.EMAIL})`
        });
      }
      default:
        return res.json({ output: 'Ismeretlen parancs. Használd: stats, latest user' });
    }
  } catch (err) {
    console.error('Hiba a parancs futtatásakor:', err);
    res.status(500).json({ message: 'Hiba a parancs futtatásakor.' });
  }
};

exports.exportOrders = async (req, res) => {
  try {
    await ensureStatusTable();

    const [rows] = await db.query(
      `SELECT k.ID_KOSAR, k.DATUMIDO, k.SZALLMOD, k.FIZMOD, k.LEIRAS,
              u.NEV, u.EMAIL,
              COALESCE(s.STATUSZ, 'pending') AS STATUSZ,
              s.MEGJEGYZES
       FROM szerviz_kosar k
       JOIN userek u ON u.ID_USER = k.ID_USER
       LEFT JOIN admin_order_status s ON s.ID_KOSAR = k.ID_KOSAR
       ORDER BY k.DATUMIDO DESC`
    );

    const header = 'ID;Dátum;Szállítás;Fizetés;Leírás;Ügyfél;Email;Státusz;Megjegyzés';
    const lines = rows.map(row => {
      const values = [
        row.ID_KOSAR,
        row.DATUMIDO ? new Date(row.DATUMIDO).toISOString() : '',
        row.SZALLMOD || '',
        row.FIZMOD || '',
        row.LEIRAS ? row.LEIRAS.replace(/[\n\r]+/g, ' ') : '',
        row.NEV || '',
        row.EMAIL || '',
        row.STATUSZ,
        row.MEGJEGYZES ? row.MEGJEGYZES.replace(/[\n\r]+/g, ' ') : ''
      ];

      return values.map(value => `"${String(value).replace(/"/g, '""')}"`).join(';');
    });

    const csv = [header, ...lines].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="rendelesek.csv"');
    res.send(csv);
  } catch (err) {
    console.error('Hiba az exportálás során:', err);
    res.status(500).json({ message: 'Hiba az exportálás során.' });
  }
};
