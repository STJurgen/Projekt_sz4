const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const path = require('path');


const app = express();
const port = 3000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Session beállítás – FONTOS!
app.use(session({
  key: 'user_sid',
  secret: 'nagyontitkos',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: false, // ha HTTPS-en futtatod, akkor legyen true
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 // 1 óra
  }
}));

// Routes
const authRoutes = require('./routes/auth');
const telepulesRoutes = require('./routes/telepulesek');
const categoriesRoutes = require('./routes/categories');
const userRoutes = require('./routes/users');
const adminRoutes = require('./routes/admin');

app.use('/api', authRoutes);
app.use('/api', telepulesRoutes);
app.use('/api/categories', categoriesRoutes);
app.use('/api/users', userRoutes);
app.use('/api/admin', adminRoutes);


// Start
app.listen(port, () => {
  console.log(`Szerver fut: http://localhost:${port}`);
});
