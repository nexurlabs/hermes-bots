const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('native', {
  platform: process.platform,
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: patch => ipcRenderer.invoke('settings:set', patch),
  http: req => ipcRenderer.invoke('http', req),
  discoverLocal: () => ipcRenderer.invoke('local:discover'),
  startLocal: () => ipcRenderer.invoke('local:start'),
  sshConnect: cfg => ipcRenderer.invoke('ssh:connect', cfg),
  cancelConnect: () => ipcRenderer.invoke('ssh:cancel'),
  logPath: () => ipcRenderer.invoke('log:path'),
  onStep: cb => {
    const handler = (_event, text) => cb(String(text || ''))
    ipcRenderer.on('connect:step', handler)
    return () => ipcRenderer.removeListener('connect:step', handler)
  },
  hermesMachines: () => ipcRenderer.invoke('hermes:machines'),
  openExternal: url => ipcRenderer.invoke('open:external', url),
  saveFile: (name, dataUrl) => ipcRenderer.invoke('file:save', { name, dataUrl }),
  openFile: (name, dataUrl) => ipcRenderer.invoke('file:open', { name, dataUrl }),
  copyText: text => ipcRenderer.invoke('clipboard:copyText', text),
  readText: () => ipcRenderer.invoke('clipboard:readText'),
  pickImage: () => ipcRenderer.invoke('pick:image'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggleMax'),
  computerGetState: () => ipcRenderer.invoke('computer:getState'),
  computerSetGranted: value => ipcRenderer.invoke('computer:setGranted', value),
  computerGetLastShot: () => ipcRenderer.invoke('computer:getLastShot'),
  computerSyncProfiles: (profiles, opts) => ipcRenderer.invoke('computer:syncProfiles', profiles, opts),
  groupsEnsureIdentity: who => ipcRenderer.invoke('groups:ensureIdentity', who),
  log: text => ipcRenderer.invoke('log:write', text),
  computerCheck: profile => ipcRenderer.invoke('computer:check', profile),
  onComputerGrantedChanged: cb => {
    const handler = (_event, value) => cb(!!value)
    ipcRenderer.on('computer:granted-changed', handler)
    return () => ipcRenderer.removeListener('computer:granted-changed', handler)
  },
  onAppToolCall: cb => {
    const handler = (_event, call) => cb(call)
    ipcRenderer.on('apptool:call', handler)
    return () => ipcRenderer.removeListener('apptool:call', handler)
  },
  hooksList: () => ipcRenderer.invoke('hooks:list'),
  hooksPut: input => ipcRenderer.invoke('hooks:put', input),
  hooksTest: (token, event, body) => ipcRenderer.invoke('hooks:test', { token, event, body }),
  hooksRemove: token => ipcRenderer.invoke('hooks:remove', token),
  hooksConfig: config => ipcRenderer.invoke('hooks:config', config),
  onHookEvent: cb => {
    const handler = (_event, value) => cb(value)
    ipcRenderer.on('hooks:event', handler)
    return () => ipcRenderer.removeListener('hooks:event', handler)
  },
  appToolResult: (id, ok, text) => ipcRenderer.send('apptool:result', { id, ok: !!ok, text: String(text || '') })
})
