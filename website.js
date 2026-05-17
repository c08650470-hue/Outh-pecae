const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const mongoose = require('mongoose');
const { create } = require('express-handlebars');
const chalk = require('chalk');
const fs = require('fs');
const path = require('path');
const User = require('./models/User');
require('dotenv').config();

// Logger setup
const log = {
  info: (msg) => console.log(chalk.blue('ℹ ') + chalk.white(msg)),
  success: (msg) => console.log(chalk.green('✓ ') + chalk.white(msg)),
  error: (msg, err) => console.error(chalk.red('✖ ') + chalk.white(msg), err || '')
};

const app = express();

// Configure Handlebars
const hbs = create({
  runtimeOptions: {
    allowProtoPropertiesByDefault: true,
    allowProtoMethodsByDefault: true
  }
});

// Database connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true
}).then(() => {
  log.success('Connected to MongoDB');
}).catch((err) => {
  log.error('MongoDB connection error:', err);
});

// Middleware setup
app.use(express.json());
app.use(express.static('public'));
app.engine('handlebars', hbs.engine);
app.set('view engine', 'handlebars');

// Middleware to capture client IP
app.use((req, res, next) => {
  req.clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || 
                 req.headers['x-real-ip'] || 
                 req.socket.remoteAddress || 
                 'unknown';
  next();
});

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());

// Load config
function loadConfig() {
  const configFile = path.join(__dirname, 'config/verify-config.json');
  if (fs.existsSync(configFile)) {
    return JSON.parse(fs.readFileSync(configFile, 'utf8'));
  }
  return { roleId: null };
}

// Get Discord client
let discordClient = null;
setTimeout(() => {
  try {
    discordClient = require('./bot');
  } catch (err) {
    log.info('Discord bot not yet initialized');
  }
}, 1000);

// Passport configuration
passport.use(new DiscordStrategy({
  clientID: process.env.DISCORD_CLIENT_ID,
  clientSecret: process.env.DISCORD_CLIENT_SECRET,
  callbackURL: process.env.CALLBACK_URL,
  scope: ['identify', 'guilds.join']
}, async (accessToken, refreshToken, profile, done) => {
  try {
    let user = await User.findOne({ discordId: profile.id });
    
    if (user) {
      // Update existing user
      Object.assign(user, {
        accessToken,
        refreshToken,
        username: profile.username,
        discriminator: profile.discriminator,
        avatar: profile.avatar
      });
      await user.save();
      log.info(`Updated user: ${profile.username}`);
    } else {
      // Create new user
      user = await User.create({
        discordId: profile.id,
        username: profile.username,
        discriminator: profile.discriminator,
        avatar: profile.avatar,
        accessToken,
        refreshToken,
        guilds: []
      });
      log.success(`New user verified: ${profile.username}`);
    }
    return done(null, user);
  } catch (error) {
    log.error('Authentication error:', error);
    return done(error, null);
  }
}));

// Passport serialization
passport.serializeUser((user, done) => {
  done(null, user.discordId);
});

passport.deserializeUser(async (discordId, done) => {
  try {
    const user = await User.findOne({ discordId });
    if (!user) return done(null, null);
    done(null, user);
  } catch (error) {
    log.error('Session error:', error);
    done(error, null);
  }
});

// Routes
app.get('/auth/discord', passport.authenticate('discord'));

app.get('/auth/discord/callback', 
  passport.authenticate('discord', { failureRedirect: '/' }),
  async (req, res) => {
    try {
      // Update user with IP address
      await User.findByIdAndUpdate(req.user._id, {
        ipAddress: req.clientIp
      });

      // Try to assign role to user in Discord
      try {
        const config = loadConfig();
        if (config.roleId && discordClient && discordClient.guilds.cache.size > 0) {
          const guilds = discordClient.guilds.cache;
          
          for (const guild of guilds.values()) {
            try {
              const member = await guild.members.fetch(req.user.discordId).catch(() => null);
              
              if (member) {
                const role = guild.roles.cache.get(config.roleId);
                if (role) {
                  await member.roles.add(role);
                  log.success(`Role assigned to ${req.user.username} in ${guild.name}`);
                }
              }
            } catch (guildErr) {
              log.info(`Could not assign role in guild: ${guildErr.message}`);
            }
          }
        }
      } catch (roleError) {
        log.error('Failed to assign role on verification:', roleError.message);
      }

      log.success(`User ${req.user.username} authenticated successfully from IP: ${req.clientIp}`);
      res.redirect('/success');
    } catch (error) {
      log.error('Failed to update user IP:', error);
      res.redirect('/success');
    }
  }
);

app.get('/', (req, res) => {
  res.render('index', { 
    user: req.user ? req.user.toObject() : null,
    title: "Peace  Services Verification"
  });
});

app.get('/success', (req, res) => {
  if (!req.user) {
    log.error('Unauthorized access attempt to success page');
    return res.redirect('/');
  }
  res.render('success', { 
    user: req.user.toObject(),
    title: 'Verification Successful'
  });
});

// Error handling
app.use((err, req, res, next) => {
  log.error('Server error:', err);
  res.status(500).render('error', { 
    message: 'An error occurred during verification. Please try again.',
    title: 'Verification Error'
  });
});

module.exports = app;