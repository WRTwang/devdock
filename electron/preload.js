'use strict';

const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, ...args) {
  const response = await ipcRenderer.invoke(channel, ...args);
  if (!response || response.ok !== true) {
    throw new Error((response && response.error) || '操作失败');
  }
  return response.data;
}

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('devdock', {
  list: () => invoke('profiles:list'),
  save: (profile) => invoke('profiles:save', profile),
  remove: (id) => invoke('profiles:delete', id),
  detect: (dir) => invoke('profiles:detect', dir),
  pickDir: () => invoke('dialog:pickDir'),
  activate: (id) => invoke('env:activate', id),
  setup: (id) => invoke('env:setup', id),
  start: (id) => invoke('env:start', id),
  stop: (id) => invoke('env:stop', id),
  status: () => invoke('env:status'),
  openDir: (dir) => invoke('shell:openDir', dir),
  openLogs: () => invoke('log:openDir'),
  revealLog: (file) => invoke('log:reveal', file),
  link: (id) => invoke('project:link', id),
  onLog: (callback) => subscribe('log:event', callback),
  onState: (callback) => subscribe('state:event', callback),
});
