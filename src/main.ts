const Store = require('electron-store');

import { app, BrowserWindow, Menu, dialog, Tray, MenuItem, clipboard, shell, nativeTheme } from 'electron';
import { ElectronBlocker, fullLists } from '@cliqz/adblocker-electron';
import { readFileSync, writeFileSync } from 'fs';

import { DarkModeCSS } from './dark';
import { ActivityType } from 'discord-api-types/v10';
import { Client as DiscordClient } from '@xhayper/discord-rpc';

import fetch from 'cross-fetch';

const localShortcuts = require('electron-localshortcut');
const prompt = require('electron-prompt');
const clientId = '1302459809471266838'; 
const store = new Store();

export interface Info {
  rpc: DiscordClient;
  ready: boolean;
  autoReconnect: boolean;
}

const info: Info = {
  rpc: new DiscordClient({ clientId }),
  ready: false,
  autoReconnect: true,
};

// app.commandLine.appendSwitch('js-flags', '--max-old-space-size=200');
// app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// app.commandLine.appendSwitch('disable-renderer-backgrounding');
// app.commandLine.appendSwitch('no-force-async-hooks-checks');
// app.commandLine.appendSwitch('ignore-certificate-errors');
// app.commandLine.appendSwitch('no-sandbox');

info.rpc.login().catch(console.error);

Menu.setApplicationMenu(null);

let mainWindow: BrowserWindow | null;
let tray: Tray | null;
let blocker: ElectronBlocker;

async function createWindow() {
  let displayWhenIdling = false;

  let bounds = store.get('bounds');
  let maximized = store.get('maximized');

  mainWindow = new BrowserWindow({
    width: bounds ? bounds.width : 1366,
    height: bounds ? bounds.height : 768,
    webPreferences: {
      nodeIntegration: false,
    },
	icon: 'soundcloud.png'
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowedDomain = 'soundcloud.com';
    const urlObject = new URL(url);

    if (!urlObject.hostname.endsWith(`.${allowedDomain}`) && urlObject.hostname !== allowedDomain) {
      event.preventDefault();
      console.warn(`Navigation to ${url} blocked. Only ${allowedDomain} and its subdomains are allowed.`);
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => {
    console.warn(`Blocked attempt to open a new window.`);
    return { action: 'deny' };
  });

  if (maximized) mainWindow.maximize();

  if (store.get('proxyEnabled')) {
    const { protocol, host } = store.get('proxyData');

    await mainWindow.webContents.session.setProxy({
      proxyRules: `${protocol}//${host}`,
    });
  }

  mainWindow.webContents.on('page-title-updated', (event) => {
    event.preventDefault();
    mainWindow.setTitle("SoundCloud");
  });

  mainWindow.webContents.on('did-navigate', async () => {
    await mainWindow.webContents.session.clearCache();
    nativeTheme.themeSource = 'dark';
  });
	
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Back',
      click: () => mainWindow.webContents.canGoBack() && mainWindow.webContents.goBack()
    },
    {
      label: 'Forward',
      click: () => mainWindow.webContents.canGoForward() && mainWindow.webContents.goForward()
    },
    {
      label: 'Refresh',
      click: () => mainWindow.webContents.reload()
    },
    {
      label: 'Copy link of current page',
      click: () => clipboard.writeText(mainWindow.webContents.getURL())
    }
  ]);

  mainWindow.webContents.on('context-menu', (event) => {
    event.preventDefault();
    contextMenu.popup();
  });

  mainWindow.loadURL('https://soundcloud.com/discover');

  const executeJS = (script: string) => mainWindow.webContents.executeJavaScript(script);

  mainWindow.webContents.on('did-finish-load', async () => {
    if (store.get('darkMode')) {
      await mainWindow.webContents.insertCSS(DarkModeCSS);
    }

    if (store.get('adBlocker')) {
      blocker = await ElectronBlocker.fromLists(
        fetch,
        fullLists,
        { enableCompression: true },
        {
          path: 'engine.bin',
          read: async (...args) => readFileSync(...args),
          write: async (...args) => writeFileSync(...args),
        },
      );
      blocker.enableBlockingInSession(mainWindow.webContents.session);
    }

    setInterval(async () => {
      const isPlaying = await executeJS(`document.querySelector('.playControls__play').classList.contains('playing')`);

      if (isPlaying) {
        const trackInfo = await executeJS(`
          new Promise(resolve => {
            const titleEl = document.querySelector('.playbackSoundBadge__titleLink');
            const authorEl = document.querySelector('.playbackSoundBadge__lightLink');
            resolve({
              title: titleEl?.innerText ?? '',
              author: authorEl?.innerText ?? ''
            });
          });
        `);

        const artworkUrl = await executeJS(`
          new Promise(resolve => {
            const artworkEl = document.querySelector('.playbackSoundBadge__avatar .image__lightOutline span');
            resolve(artworkEl ? artworkEl.style.backgroundImage.slice(5, -2) : '');
          });
        `);

        const [elapsedTime, totalTime] = await Promise.all([
          executeJS(`document.querySelector('.playbackTimeline__timePassed span:last-child')?.innerText ?? ''`),
          executeJS(`document.querySelector('.playbackTimeline__duration span:last-child')?.innerText ?? ''`),
        ]);

        const parseTime = (time: string): number => {
          const parts = time.split(':').map(Number);
          return parts.reduce((acc, part) => 60 * acc + part, 0) * 1000;
        };

        const elapsedMilliseconds = parseTime(elapsedTime);
        const totalMilliseconds = parseTime(totalTime);
        const currentTrack = trackInfo.title.replace(/\n.*/s, '').replace('Current track:', '');

        info.rpc.user?.setActivity({
          type: ActivityType.Listening,
          details: `${shortenString(currentTrack)}ᅠᅠᅠ`,
          state: `${shortenString(trackInfo.author)}ᅠᅠᅠ`,
          largeImageKey: artworkUrl.replace('50x50.', '500x500.'),
          startTimestamp: Date.now() - elapsedMilliseconds,
          endTimestamp: Date.now() + (totalMilliseconds - elapsedMilliseconds),
          instance: false,
        });
      } else {
        info.rpc.user?.clearActivity();
      }
    }, 10000);
  });

  mainWindow.on('close', function(event) {
    store.set('bounds', mainWindow.getBounds());
    store.set('maximized', mainWindow.isMaximized());
	event.preventDefault();
	mainWindow.hide();
  });

  mainWindow.on('closed', function() {
    mainWindow = null;
  });

  localShortcuts.register(mainWindow, 'F1', () => toggleDarkMode());
  localShortcuts.register(mainWindow, 'F2', () => toggleAdBlocker());
  localShortcuts.register(mainWindow, 'F3', async () => toggleProxy());
  localShortcuts.register(mainWindow, 'F5', () => mainWindow.webContents.reload()); 

  localShortcuts.register(mainWindow, ['CmdOrCtrl+B', 'CmdOrCtrl+P'], () => mainWindow.webContents.goBack());
  localShortcuts.register(mainWindow, ['CmdOrCtrl+F', 'CmdOrCtrl+N'], () => mainWindow.webContents.goForward());
  localShortcuts.register(mainWindow, ['CmdOrCtrl+F', 'CmdOrCtrl+R'], () => mainWindow.webContents.reload());

  createTray();
}

function toggleDarkMode() {
  const darkModeEnabled = store.get('darkMode');
  store.set('darkMode', !darkModeEnabled);

  if (mainWindow) {
    mainWindow.reload();
    dialog.showMessageBox({ message: darkModeEnabled ? 'Dark mode disabled' : 'Dark mode enabled', title: ' ', icon: 'soundcloud.png' });
  }
}

function createTray() {
  tray = new Tray('soundcloud.png');
  const contextMenu = Menu.buildFromTemplate([
    { label: 'sevcator.github.io', enabled: false },
	{ label: 'sevcator.t.me', enabled: false },
    { type: 'separator' },
    { label: 'Quit', click: () => {
      if (mainWindow) mainWindow.destroy();
      if (tray) tray.destroy();
      app.quit();
    }}
  ]);

  tray.setToolTip('SoundCloud');
  tray.setContextMenu(contextMenu);
  
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    }
  });
}

app.on('ready', createWindow);

app.on('window-all-closed', function() {
  if (process.platform !== 'darwin') {
    if (mainWindow) mainWindow.destroy();
    if (tray) tray.destroy();
    app.quit();
  }
});

app.on('activate', function() {
  if (mainWindow === null) {
    createWindow();
  }
});

function toggleAdBlocker() {
  const adBlockEnabled = store.get('adBlocker');
  store.set('adBlocker', !adBlockEnabled);

  if (adBlockEnabled) {
    if (blocker) blocker.disableBlockingInSession(mainWindow.webContents.session);
  }

  if (mainWindow) {
    mainWindow.reload();
    dialog.showMessageBox({ message: adBlockEnabled ? 'Adblocker disabled' : 'Adblocker enabled', title: ' ', icon: 'soundcloud.png' });
  }
}

app.on('login', (_event, _webContents, _request, authInfo, callback) => {
  if (authInfo.isProxy) {
    if (!store.get('proxyEnabled')) {
      return callback('', '');
    }

    const { user, password } = store.get('proxyData');
    callback(user, password);
  }
});

async function toggleProxy() {
  const proxyUri = await prompt({
    title: ' ',
    label: "Enter proxy, type 0 to disable proxy",
    value: "http://user:password@ip:port",
    inputAttrs: {
      type: 'uri',
    },
    type: 'input',
	icon: 'soundcloud.png',
  });

  if (proxyUri === null) return;

  if (proxyUri === '0') {
    store.set('proxyEnabled', false);
    dialog.showMessageBox({ message: 'The proxy will be disabled after the application is restarted', title: ' ', icon: 'soundcloud.png' });
	if (mainWindow) mainWindow.destroy();
    if (tray) tray.destroy();
    app.quit();
  } else {
    try {
      const url = new URL(proxyUri);
      store.set('proxyEnabled', true);
      store.set('proxyData', {
        protocol: url.protocol,
        host: url.host,
        user: url.username,
        password: url.password,
      });
      dialog.showMessageBox({ message: 'The proxy will be applied after the application is restarted', title: ' ', icon: 'soundcloud.png' });
	  if (mainWindow) mainWindow.destroy();
      if (tray) tray.destroy();
      app.quit();
    } catch (error) {
      dialog.showMessageBox({ message: 'Failed to setup proxy', title: ' ', icon: 'soundcloud.png' });
    }
  }
}

function shortenString(str: string): string {
  return str.length > 128 ? str.substring(0, 125) + '...' : str;
}
