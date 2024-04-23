/* eslint-disable no-console */
const serveStatic = require('serve-static');
const path = require('path');
const events = require('events');
const fs = require('fs');

const session = require('express-session');
const _ = require('lodash');
const fileupload = require('express-fileupload');
const cloudinary = require('cloudinary').v2;
const fetch = require('node-fetch');

const lcd = require('../lib/lcd/index');
const DatabaseSchema = require('../database/index');
const validators = require('../lib/helpers/validators');
const uploadFromBuffer = require('../lib/helpers/upload-from-buffer');
const chatbotIdGenerator = require('../lib/utils/chatbot-id-generator');
const GetEnvironment = require('../lib/helpers/get-environment');
const { getMigrations } = require('../lib/utils/migration');
const { isEmptyDatabase, tableExists } = require('../lib/utils/database');
const { defineQueueTable } = require('../lib/queues-store/index');

const { REDBOT_ENABLE_MISSION_CONTROL } = require('../src/env');

let initialized = false;
const Events = new events.EventEmitter();

function sendMessage(topic, payload) {
  Events.emit('message', topic, payload);
}

// webpack https://webpack.js.org/guides/getting-started/
// from https://github.com/node-red/node-red-dashboard/blob/63da162998c421b43a6e5ebf447ed90e04040aa3/ui.js#L309

// web socket docs
// https://github.com/websockets/ws#api-docs

// design
// https://adminlte.io/themes/v3/index2.html

// Inspiration design
// https://colorlib.com/wp/free-dashboard-templates/
// clone schema https://demo.uifort.com/bamburgh-admin-dashboard-pro/
// React grid
// https://github.com/STRML/react-grid-layout#installation
// useQuery
// https://www.apollographql.com/docs/react/data/queries/


let _mcSettings = null; // cache it
function getMissionControlConfiguration(redSettings) {
  if (_mcSettings != null) {
    return _mcSettings;
  }

  const mcSettings = redSettings.RedBot || {};

  // get current version
  const jsonPackage = fs.readFileSync(__dirname + '/../package.json');
  let packageJson;
  try {
    packageJson = JSON.parse(jsonPackage.toString());
  } catch(e) {
    lcd.error('Unable to open node-red-contrib-chatbot/package.json');
  }
  // front end evironment
  mcSettings.version = packageJson.version;

  let frontendEnvironment = 'production';
  if (process.env.REDBOT_DEVELOPMENT_MODE != null && (
    process.env.REDBOT_DEVELOPMENT_MODE.toLowerCase() === 'true' ||
    process.env.REDBOT_DEVELOPMENT_MODE.toLowerCase() === 'dev' ||
    process.env.REDBOT_DEVELOPMENT_MODE.toLowerCase() === 'development'
  )) {
    frontendEnvironment = 'development';
  } else if (process.env.REDBOT_DEVELOPMENT_MODE != null && process.env.REDBOT_DEVELOPMENT_MODE.toLowerCase() === 'plugin') {
    frontendEnvironment = 'plugin';
  }
  mcSettings.frontendEnvironment = frontendEnvironment;

  mcSettings.salt = !_.isEmpty(redSettings.credentialSecret) ? redSettings.credentialSecret : 'redbot-salt';

  if (!_.isEmpty(process.env.REDBOT_DB_PATH)) {
    mcSettings.dbPath = path.join(process.env.REDBOT_DB_PATH, 'mission-control.sqlite');
    mcSettings.dbQueuePath = path.join(process.env.REDBOT_DB_PATH, 'queues.sqlite');
  } else if (mcSettings.dbPath == null) {
    mcSettings.dbPath = path.join(redSettings.userDir, 'mission-control.sqlite');
    mcSettings.dbQueuePath = path.join(redSettings.userDir, 'queues.sqlite');
  } else {
    mcSettings.dbPath = mcSettings.dbPath.replace(/\/$/, '') + '/mission-control.sqlite';
    mcSettings.dbQueuePath = mcSettings.dbPath.replace(/\/$/, '') + '/queues.sqlite';
  }

  if (mcSettings.pluginsPath == null && !fs.existsSync(mcSettings.pluginsPath)) {
    mcSettings.pluginsPath = path.join(redSettings.userDir, 'dist-plugins');
  }
  if (!fs.existsSync(mcSettings.pluginsPath)) {
    // try to create it
    try {
      fs.mkdirSync(mcSettings.pluginsPath);
    } catch(e) {
      console.log(lcd.timestamp() + '  ' + lcd.orange(`Unable to create plugins dir: ${mcSettings.pluginsPath}`));
    }
  }

  // get root
  if (mcSettings.root == null) {
    mcSettings.root = '/mc';
  } else {
    mcSettings.root = mcSettings.root.replace(/\/$/, '');
  }
  if (!_.isEmpty(redSettings.httpAdminRoot)) {
    mcSettings.root = redSettings.httpAdminRoot.replace(/\/$/, '') + mcSettings.root;
  }

  // get host
  if (mcSettings.host == null) {
    mcSettings.host = 'localhost';
  }

  // get port
  mcSettings.port = redSettings.uiPort;

  _mcSettings = mcSettings;
  return mcSettings;
}


async function bootstrap(server, app, log, redSettings, RED) {
  const mcSettings = getMissionControlConfiguration(redSettings);
  const { frontendEnvironment } = mcSettings;

  // check if mission control is enabled
  if (!(mcSettings.enableMissionControl || REDBOT_ENABLE_MISSION_CONTROL === 'true')) {
    console.log(lcd.timestamp() + 'Red Bot Mission Control is not enabled.');
    console.log(lcd.timestamp() + '  ' + lcd.grey('Enable it running with the REDBOT_ENABLE_MISSION_CONTROL environment variable:'));
    console.log(lcd.timestamp() + '  ' + lcd.grey('  REDBOT_ENABLE_MISSION_CONTROL=true node-red -u /my-user-dir'));
    console.log('');
    return;
  }
  console.log(lcd.timestamp() + 'Red Bot Mission Control configuration:');
  console.log(lcd.timestamp() + '  ' + lcd.green('admin root: ') + lcd.grey(redSettings.httpAdminRoot));
  console.log(lcd.timestamp() + '  ' + lcd.green('backend environment: ') + lcd.grey(GetEnvironment(RED)()));
  console.log(lcd.timestamp() + '  ' + lcd.green('front end environment: ') + lcd.grey(frontendEnvironment));
  if (mcSettings.salt == 'redbot-salt') {
    console.log(lcd.timestamp() + '  ' + lcd.green('salt: ') + lcd.grey('default'));
  } else {
    console.log(lcd.timestamp() + '  ' + lcd.green('salt: ') + lcd.grey('****'));
  }
  console.log(lcd.timestamp() + '  ' + lcd.green('dbPath: ') + lcd.grey(mcSettings.dbPath));
  const { passportMiddlewares, passport } = require('../lib/authentication/index')({
    dbPath: mcSettings.dbPath,
    salt: mcSettings.salt
  });
  console.log(lcd.timestamp() + '  ' + lcd.green('pluginsPath: ') + lcd.grey(mcSettings.pluginsPath));
  if (mcSettings.pluginsPath == path.join(__dirname, 'dist-plugins')) {
    console.log(lcd.timestamp() + '  ' + lcd.orange('Warning: external plugin path is the default one in the npm package, the external plugins'));
    console.log(lcd.timestamp() + '  ' + lcd.orange('will be overwritten if the package is reinstalled, this is good for development but dangerous'));
    console.log(lcd.timestamp() + '  ' + lcd.orange('for production. Select a different directory with permission rights.'))
  }
  console.log(lcd.timestamp() + '  ' + lcd.green('MC root: ') + lcd.grey(mcSettings.root));
  console.log(lcd.timestamp() + '  ' + lcd.green('host: ') + lcd.grey(mcSettings.host));
  console.log(lcd.timestamp() + '  ' + lcd.green('port: ') + lcd.grey(mcSettings.port));
  // get google maps key
  if (mcSettings.googleMapsKey != null) {
    console.log(lcd.timestamp() + '  ' + lcd.green('googleMapsKey: ') + lcd.grey(mcSettings.googleMapsKey));
  }
  if (validators.credentials.cloudinary(mcSettings.cloudinary)) {
    console.log(lcd.timestamp() + '  ' + lcd.green('cloudinary name: ') + lcd.grey(mcSettings.cloudinary.cloudName));
    console.log(lcd.timestamp() + '  ' + lcd.green('cloudinary apiKey: ') + lcd.grey(mcSettings.cloudinary.apiKey));
    console.log(lcd.timestamp() + '  ' + lcd.green('cloudinary apiSecret: ') + lcd.grey('****'));
    cloudinary.config({
      cloud_name: mcSettings.cloudinary.cloudName,
      api_key: mcSettings.cloudinary.apiKey,
      api_secret: mcSettings.cloudinary.apiSecret
    });
  } else {
    mcSettings.cloudinary = null;
  }

  const databaseSchema = DatabaseSchema(mcSettings)
  const { graphQLServer, Category, Content, Admin,  ChatBot, Plugin, sequelize, sequelizeTasks } = databaseSchema;

  // create the default queue if not exists
  if (!(await tableExists('tasks', sequelizeTasks))) {
    const tasksModel = defineQueueTable(sequelizeTasks, 'tasks');
    await tasksModel.sync({ force: true });
  }

  app.use(session({
    secret: mcSettings.salt,
    resave: true,
    saveUninitialized: false
  }));
  app.use(passportMiddlewares);

  app.post(
    `${mcSettings.root}/login`,
    passport.authenticate('local', {
      successRedirect: `${mcSettings.root}`,
      failureRedirect: `${mcSettings.root}/login`
    })
  );

  // eslint-disable-next-line no-console
  console.log(lcd.timestamp() + '  ' + lcd.green('GraphQL URL: ')
  + lcd.grey(`http://localhost:${mcSettings.port}${graphQLServer.graphqlPath}`));

 
}


module.exports = function(RED) {
  if (!initialized) {
    initialized = true;
    bootstrap(RED.server, RED.httpNode || RED.httpAdmin, RED.log, RED.settings, RED);
  }
  // exposed methods
  return {
    Events,
    sendMessage: sendMessage,
    getMissionControlConfiguration: () => getMissionControlConfiguration(RED.settings)
  };
};
