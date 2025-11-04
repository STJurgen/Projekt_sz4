const db = require('../config/db');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');

const VAT = 0.27; // ÁFA 27%

// GET /api/users/tasks
async function getTasks(req, res) {
  try {
    const [rows] = await db.execute(`
      SELECT k.ID_KOSAR, k.ID_USER, k.SZALLMOD, k.FIZMOD, k.LEIRAS, k.DATUMIDO,
             t.ID_KOSARTETEL, t.NEV as tetelNev, t.KONDI, t.MUNKAORA, t.MUNkADIJ, t.ANYAGDIJ, t.VEGOSSZEG, t.AZONOSITO,
             u.NEV, u.EMAIL
      FROM szerviz_kosar k
      LEFT JOIN szerviz_kosar_tetelei t ON k.ID_KOSAR = t.ID_KOSAR
      JOIN userek u ON k.ID_USER = u.ID_USER
      ORDER BY k.DATUMIDO DESC, t.ID_KOSARTETEL DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Hiba a feladatok betöltésekor' });
  }
}


// --- EGYEDI AZONOSÍTÓ GENERÁLÁS ---
function generateUniqueId() {
  const date = new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const random = Math.floor(1000 + Math.random() * 9000); // 4 jegyű
  return `PC-${y}${m}${d}-${random}`;
}

// --- ÁRAJÁNLAT KÜLDÉSE ---

async function sendOffer(req, res) {
  try {
    const { taskId, userId, munkaora, munkadij, anyagdij, felvDatum, kiadDatum, categoryId, operatorId } = req.body;

    if (!categoryId) return res.status(400).json({ message: 'Kérlek válassz kategóriát!' });

    const munkaoraNum = Number(munkaora);
    const munkadijNum = Number(munkadij);
    const anyagdijNum = Number(anyagdij);

    if (!Number.isFinite(munkaoraNum) || !Number.isFinite(munkadijNum) || !Number.isFinite(anyagdijNum)) {
      return res.status(400).json({ message: 'Hibás számadat, kérlek ellenőrizd a mezőket!' });
    }

    if (munkaoraNum <= 0 || munkadijNum <= 0 || anyagdijNum < 0) {
      return res.status(400).json({ message: 'Hibás számadat, nem lehet nulla!' });
    }

    const netto = munkaoraNum * munkadijNum + anyagdijNum;
    const afa = netto * VAT;
    const brutto = netto + afa;

    const userEmail = await getUserEmail(userId);
    const uniqueId = generateUniqueId();

    const doc = new PDFDocument({ margin: 50 });
    let buffers = [];
    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', async () => {
      const pdfData = Buffer.concat(buffers);

      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT),
        secure: process.env.SMTP_SECURE === 'true',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      });

      const acceptLink = `http://localhost:3000/api/users/tasks/accept/${taskId}/${userId}`;

      await transporter.sendMail({
        from: '"PROCOMP" <info@procomp.hu>',
        to: userEmail,
        subject: 'Árajánlat',
        html: `<p>Kedves Ügyfelünk!</p>
               <p>Csatolva találja az Ön részére készült <b>árajánlatot</b> (azonosító: <b>${uniqueId}</b>).</p>
               <p>Elfogadás: <a href="${acceptLink}">${acceptLink}</a></p>
               <p>Ha 20 perc alatt nem fogadja el, akkor automatikusan törlődik és elutasítjuk az ajánlatot.</p>
               <p>Üdvözlettel,<br><b>PROCOMP Szerviz</b></p>`,
        attachments: [{ filename: 'arajanlat.pdf', content: pdfData }]
      });

      await db.execute(
        `INSERT INTO szerviz_kosar_tetelei 
          (ID_KOSAR, ID_KATEGORIA, ID_OPERATOR, NEV, AZONOSITO, FELV_DATUM, KIAD_DATUM, KONDI, MUNkADIJ, ANYAGDIJ, MUNKAORA, VEGOSSZEG, LEIRAS) 
         VALUES (?, ?, ?, ?, ?, NOW(), ?, 'sent', ?, ?, ?, ?, ?)`,
        [taskId, categoryId, operatorId, 'Árajánlat', uniqueId, kiadDatum, munkadijNum, anyagdijNum, munkaoraNum, brutto, '']
      );

      // --- 20 perces automatikus elutasítás ---
      setTimeout(() => {
        rejectTaskIfExpired(taskId).catch(err => {
          console.error('Hiba az automatikus elutasításkor:', err);
        });
      }, 20 * 60 * 1000); // 20 perc

      res.json({ message: 'Árajánlat elküldve PDF-ben', netto, brutto, azonosito: uniqueId });
    });

    // --- PDF tartalom modern stílusban ---
    doc
      .fillColor('#1e3a8a')
      .fontSize(22)
      .text('PROCOMP Szerviz - Árajánlat', { align: 'center' })
      .moveDown(1.5);

    doc
      .fontSize(12)
      .fillColor('#333')
      .text(`Ügyfél: ${userEmail}`)
      .text(`Dátum: ${new Date().toLocaleDateString()}`)
      .text(`Azonosító: ${uniqueId}`)
      .moveDown(1);

    doc
      .fontSize(14)
      .fillColor('#000')
      .text('Részletek:', { underline: true });

    doc
      .fontSize(12)
      .text(`Munkaóra: ${munkaoraNum} óra`)
      .text(`Óradíj: ${munkadijNum.toLocaleString()} Ft`)
      .text(`Anyagdíj: ${anyagdijNum.toLocaleString()} Ft`)
      .moveDown(0.5)
      .text(`Nettó összeg: ${netto.toLocaleString()} Ft`)
      .text(`ÁFA (27%): ${afa.toLocaleString()} Ft`)
      .text(`Bruttó összeg: ${brutto.toLocaleString()} Ft`);

    doc.end();

  } catch (err) {
    console.error('Hiba az árajánlat küldésekor:', err);
    res.status(500).json({ message: 'Hiba az árajánlat küldésekor' });
  }
}

// --- FELADAT AUTOMATIKUS ELUTASÍTÁSA 20 PERC UTÁN ---
async function rejectTaskIfExpired(taskId, { force = false } = {}) {
  try {
    const [rows] = await db.execute(
      `SELECT FELV_DATUM, KONDI FROM szerviz_kosar_tetelei WHERE ID_KOSAR=? ORDER BY ID_KOSARTETEL DESC LIMIT 1`,
      [taskId]
    );
    if (!rows.length) return false;

    const task = rows[0];
    if (!force && task.KONDI !== 'sent') return false; // már elfogadva vagy lezárva

    if (!force) {
      const sentTime = new Date(task.FELV_DATUM);
      const now = new Date();
      const minutesElapsed = (now - sentTime) / 1000 / 60;

      if (minutesElapsed < 20) {
        return false;
      }
    }

    const [result] = await db.execute(
      `UPDATE szerviz_kosar_tetelei SET KONDI='closed' WHERE ID_KOSAR=? AND KONDI='sent'`,
      [taskId]
    );

    if (!result.affectedRows) {
      return false;
    }

    if (force) {
      console.log(`Task ${taskId} manuálisan elutasítva.`);
    } else {
      console.log(`Task ${taskId} automatikusan elutasítva 20 perc elteltével.`);
    }

    return true;
  } catch (err) {
    console.error('Hiba az automatikus elutasításkor:', err);
    return false;
  }
}

// --- ÁRAJÁNLAT ELFOGADÁSA ---


async function rejectTask(req, res) {
  const { taskId } = req.body;

  if (!taskId) {
    return res.status(400).json({ message: 'taskId szükséges' });
  }

  try {
    const rejected = await rejectTaskIfExpired(taskId, { force: true });

    if (!rejected) {
      return res.status(404).json({ message: 'Feladat nem található vagy már nem törölhető' });
    }

    res.json({ message: 'Feladat elutasítva' });
  } catch (err) {
    console.error('Hiba a feladat elutasításakor:', err);
    res.status(500).json({ message: 'Hiba a feladat elutasításakor' });
  }
}

async function acceptOffer(req, res) {
  try {
    const { taskId } = req.params;
    await db.execute(`UPDATE szerviz_kosar_tetelei SET KONDI='process', FELV_DATUM=NOW() WHERE ID_KOSAR=?`, [taskId]);
    res.send('Árajánlat elfogadva, a munka folyamatban.');
  } catch (err) {
    console.error(err);
    res.status(500).send('Hiba az elfogadáskor');
  }
}

//kész cucuc
async function completeTask(req, res) {
  console.log('=== DEBUG: completeTask ENTRY POINT ===');

  // --- taskId lekérése POST body-ból vagy GET query-ből ---
  const  taskId  = req.body?.taskId || req.query?.taskId;
  console.log('DEBUG: Received taskId:', taskId);

   //kep és mai nap:
   const path = require('path');
   const logoPath = path.join(__dirname, '../public/kepek/logopic.png');
   const today = new Date().toISOString().slice(0,10);

  if (!taskId) {
    console.error('DEBUG: taskId nincs megadva!');
    return res.status(400).json({ message: 'taskId szükséges' });
  }

  try {
    // --- Lekérdezés az adatbázisból, csak process állapotú tétel ---
    const [rows] = await db.execute(`
      SELECT t.*, k.SZALLMOD, k.FIZMOD, k.ID_USER, u.NEV, u.EMAIL, u.TELEFON 
      FROM szerviz_kosar_tetelei t
      JOIN szerviz_kosar k ON t.ID_KOSAR = k.ID_KOSAR
      JOIN userek u ON k.ID_USER = u.ID_USER
      WHERE t.ID_KOSAR=? AND t.KONDI='process'
      ORDER BY t.ID_KOSARTETEL DESC
      LIMIT 1
    `, [taskId]);

    const t = rows[0];
    if (!t) {
      console.error('DEBUG: Nincs process állapotú tétel vagy nem található a taskId.');
      return res.status(404).json({ message: 'Feladat nem található vagy nem process állapotú.' });
    }
    console.log('DEBUG: DB query result:', t);

  // --- Újraszámolás ---
   const netto = t.MUNKAORA * t.MUNkADIJ + t.ANYAGDIJ; 
   const afa = netto * VAT; 
   console.log('DEBUG: Számított értékek:', { netto, afa});


    // --- PDF létrehozása ---
    const doc = new PDFDocument({ margin: 50 });
    let buffers = [];
    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', async () => {
      try {
        const pdfData = Buffer.concat(buffers);
        console.log('DEBUG: PDF kész, méret:', pdfData.length);

        // --- Email küldés ---
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT),
          secure: process.env.SMTP_SECURE === 'true',
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        });

        await transporter.sendMail({
          from: '"PROCOMP" <info@procomp.hu>',
          to: t.EMAIL,
          subject: 'Számla elkészült',
          html: `<p>Kedves ${t.NEV},</p>
                 <p>A javítás elkészült. Mellékelve találja a számlát PDF formátumban (azonosító: <b>${t.AZONOSITO}</b>).</p>
                 <p>Üdvözlettel,<br><b>PROCOMP Szerviz</b></p>`,
          attachments: [{ filename: 'szamla.pdf', content: pdfData }]
        });
        console.log('DEBUG: Email elküldve:', t.EMAIL);

        // --- Mentés a mentes táblába ---
        await db.execute(`
          INSERT INTO mentes 
          (ID_TELEPULES, ID_TELEPULES_SZML, DATUMIDO, fizmod, szallmod, kiad_datum, vegosszeg, TELEFON)
          VALUES (?, ?, NOW(), ?, ?, ?, ?, ?)
        `, [t.ID_KOSAR, t.ID_KOSAR, t.FIZMOD, t.SZALLMOD, today, t.VEGOSSZEG , t.TELEFON]);
        console.log('DEBUG: Adatok mentve a mentes táblába.');

        // --- Feladat lezárása ---
        await db.execute(`UPDATE szerviz_kosar_tetelei SET KONDI='closed' WHERE ID_KOSAR=?`, [taskId]);
        console.log('DEBUG: Feladat lezárva (KONDI=closed)');

        res.json({ message: 'Feladat befejezve, PDF számla elküldve', netto, afa });
      } catch(err) {
        console.error('DEBUG: Hiba a PDF/email/mentés részben:', err);
        res.status(500).json({ message: 'Hiba a PDF/email/mentés részben' });
      }
    });
      

    // --- PDF tartalom ---
    doc
      .image(logoPath, 50, 45, { width: 100 })
      .fillColor('#1e3a8a')
      .fontSize(20)
      .text('PROCOMP Szerviz', 160, 50)
      .fontSize(12)
      .fillColor('#000')
      .text('Cím: 1234 Budapest, Szerviz u. 1.', 160, 75)
      .text('Email: info@procomp.hu', 160, 90)
      .text('Telefon: +36 1 234 5678', 160, 105)
      .moveDown(2);

    doc
      .fontSize(16)
      .fillColor('#000')
      .text(`Számla azonosító: ${t.AZONOSITO}`, { align: 'right' })
      .text(`Dátum: ${today}`, { align: 'right' })
      .moveDown(2);

    doc
      .fontSize(12)
      .fillColor('#333')
      .text(`Ügyfél: ${t.NEV}`)
      .text(`Email: ${t.EMAIL}`)
      .text(`Telefon: ${t.TELEFON}`)
      .moveDown(1);

    doc
      .fontSize(14)
      .fillColor('#000')
      .text('Számlázott tételek:', { underline: true });

    doc
      .fontSize(12)
      .text(`Munkaóra: ${t.MUNKAORA} x ${t.MUNkADIJ.toLocaleString()} Ft = ${(t.MUNKAORA * t.MUNkADIJ).toLocaleString()} Ft`)
      .text(`Anyagdíj: ${t.ANYAGDIJ.toLocaleString()} Ft`)
      .moveDown(0.5);

    doc
      .fontSize(12)
      .text(`Nettó összeg: ${netto.toLocaleString()} Ft`)
      .text(`ÁFA (27%): ${afa.toLocaleString()} Ft`)
      .fontSize(14)
      .fillColor('#1e3a8a')
      .text(`Bruttó összeg: ${t.VEGOSSZEG.toLocaleString()} Ft`, { underline: true })
      .moveDown(2);

    doc
      .fontSize(12)
      .fillColor('#333')
      .text('Köszönjük, hogy minket választott!', { align: 'center' })
      .text('PROCOMP Szerviz', { align: 'center' })
      .text('info@procomp.hu | +36 1 234 5678', { align: 'center' });

    doc.end();

  } catch (err) {
    console.error('DEBUG: Hiba a feladat befejezésekor:', err);
    res.status(500).json({ message: 'Hiba a feladat befejezésekor' });
  }
}



// --- SEGÉDFÜGGVÉNY ---
async function getUserEmail(userId) {
  const [rows] = await db.execute(`SELECT EMAIL FROM userek WHERE ID_USER=?`, [userId]);
  return rows[0]?.EMAIL;
}

module.exports = {
  getTasks,
  sendOffer,
  rejectTask,
  acceptOffer,
  completeTask
};
