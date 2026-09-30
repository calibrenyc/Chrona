const fs = require('node:fs/promises');
const crypto = require('node:crypto');

class DownloadHistory {
  constructor({ getStore, save, install, changed = () => {} }) {
    Object.assign(this, { getStore, save, install, changed });
    this.installing = new Set();
  }
  get entries() { return this.getStore().downloadHistory ||= []; }
  async initialize() {
    for (const old of this.getStore().pendingDownloads || []) {
      if (!this.entries.some(entry => entry.id === old.retryId || entry.file === old.file)) this.entries.push({
        ...old, id: old.retryId || crypto.randomUUID(), status: old.interrupted ? 'interrupted' : 'failed',
        complete: !old.interrupted, createdAt: new Date().toISOString(), error: old.interrupted ? 'Download did not finish.' : 'Installation needs to be retried.'
      });
    }
    for (const entry of this.entries) {
      if (entry.status === 'downloading') { entry.status = 'interrupted'; entry.error = 'Download interrupted when Chrona closed.'; }
      if (entry.status === 'installing') { entry.status = 'failed'; entry.error = 'Installation interrupted. The downloaded file is available to retry.'; }
    }
    this.getStore().pendingDownloads = [];
    await this.save();
  }
  find(id) { const entry = this.entries.find(entry => entry.id === id); if (!entry) throw new Error('This download is no longer in your history.'); return entry; }
  async update(entry, values) { Object.assign(entry, values, { updatedAt: new Date().toISOString() }); await this.save(); this.changed(); }
  async list() {
    return Promise.all(this.entries.map(async entry => {
      const stat = await fs.stat(entry.file).catch(() => null);
      return { ...entry, fileExists: !!stat?.isFile(), availableBytes: stat?.size || 0 };
    }));
  }
  async installSaved(id) {
    const entry = this.find(id);
    if (this.installing.size) throw new Error('An installation is already running. Please wait for it to finish.');
    if (!entry.complete) throw new Error('This download is incomplete. Open its source to download the remaining file before installing.');
    this.installing.add(id);
    try {
      const stat = await fs.stat(entry.file).catch(() => null);
      if (!stat?.isFile() || !stat.size) throw new Error('The saved download is missing or empty. Restore the file to its saved location.');
      if (!entry.multiPartFiles?.length && entry.expectedBytes > 0 && stat.size !== entry.expectedBytes) throw new Error('The saved file size does not match the completed download.');
      await this.update(entry, { status: 'installing', error: '' });
      // Use the metadata captured for these bytes, never today's website version.
      const result = await this.install(entry.file, entry.game, entry.installRoot, entry);
      await this.update(entry, { status: result?.status || 'installed', error: '', installedAt: new Date().toISOString() });
      return true;
    } catch (error) { await this.update(entry, { status: 'failed', error: error.message }); throw error; }
    finally { this.installing.delete(id); }
  }
}
module.exports = { DownloadHistory };
