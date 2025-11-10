const transporter = require('./config/mailer');

async function main() {
  try {
    const info = await transporter.sendMail({
      from: process.env.FROM_DEFAULT,
      to: 'stenzel.juergen.robert@csany-zeg.hu', // ide írj egy valós címet
      subject: 'Teszt email',
      text: 'Ez egy teszt üzenet a Nodemailerből.',
    });
    console.log('Email elküldve:', info.messageId);
  } catch (err) {
    console.error('Hiba:', err);
  }
}

main();

// sezreteme  audbhawvdahwdvzaw