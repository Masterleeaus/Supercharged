(() => {
  'use strict';

  const APP_PROFILES = {
    'titan-zero': { headline: 'Business briefing', recordTypes: ['work_order','invoice','approval','lead'], actions: ['Review operations','Open approvals','Switch app'], empty: 'No urgent cross-application issues are stored on this device.' },
    'titan-go': { headline: 'Today in the field', recordTypes: ['job_pack','work_order','job','appointment'], actions: ['Open next job','Review dispatch','Sync now'], empty: 'No assigned jobs or dispatch records are downloaded yet.' },
    'titan-launch': { headline: 'Launch and growth workspace', recordTypes: ['launch_plan','vertical_blueprint','campaign','opportunity'], actions: ['Open launchpad','Build vertical','Review growth'], empty: 'No launch plans or growth records are stored on this device.' },
    'titan-desk': { headline: 'Business communications', recordTypes: ['conversation','lead','booking_request','quote_request','follow_up'], actions: ['Open inbox','Qualify enquiry','Review follow-ups'], empty: 'No enquiries or communication records are stored locally.' },
    'titan-hub': { headline: 'Your services', recordTypes: ['booking','quote','invoice','service_history'], actions: ['Book service','Request quote','View payments'], empty: 'No bookings or account records are available offline.' }
  };

  const LEGACY_APPLICATIONS = {
    'titan-dispatch': 'titan-go',
    'titan-front-desk': 'titan-desk',
    'titan-sprout': 'titan-launch',
    'titan-marketing': 'titan-launch',
    'titan-social': 'titan-launch',
    'titan-money': 'titan-zero',
    'titan-teams': 'titan-zero',
    'titan-analytics': 'titan-zero',
    'titan-locker': 'titan-zero',
    'titan-office': 'titan-zero',
    'titan-quality': 'titan-zero'
  };

  const canonicalApplication = slug => LEGACY_APPLICATIONS[slug] || slug;
  const safeText = (value, fallback = '') => {
    const text = value == null ? '' : String(value);
    return text.trim() || fallback;
  };
  const escapeHtml = value => safeText(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\"', '&quot;')
    .replaceAll("'", '&#039;');
  const safeDataValue = value => encodeURIComponent(safeText(value));

  const humanise = value => safeText(value).replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const firstValue = (record, keys, fallback = '') => {
    for (const key of keys) {
      const value = key.split('.').reduce((current, part) => current?.[part], record);
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return fallback;
  };

  class TitanOperationalWorkspace {
    constructor(element) {
      this.element = element;
      try { this.schema = JSON.parse(element.dataset.schema || '{}'); } catch (_) { this.schema = {}; }
      const requestedTemplate = element.dataset.template || this.schema?.identity?.slug || 'titan-zero';
      this.template = canonicalApplication(requestedTemplate);
      this.view = this.schema?.navigation?.default_view || 'home';
      this.profile = APP_PROFILES[this.template] || APP_PROFILES['titan-zero'];
      this.records = [];
      this.loading = false;
      this.bind();
      this.refresh();
    }

    bind() {
      window.addEventListener('titan:navigate', event => {
        if (event.detail?.template && canonicalApplication(event.detail.template) !== this.template) return;
        this.view = event.detail?.view || this.view;
        this.refresh();
      });
      window.addEventListener('workcore:sync-completed', () => this.refresh());
      this.element.addEventListener('click', event => {
        const encodedAction = event.target.closest('[data-titan-action]')?.dataset.titanAction;
        const action = encodedAction ? decodeURIComponent(encodedAction) : '';
        if (action) this.performAction(action);
        const encodedRecordId = event.target.closest('[data-record-id]')?.dataset.recordId;
        if (encodedRecordId) this.openRecord(decodeURIComponent(encodedRecordId));
      });
    }

    async loadRecords() {
      const client = window.TitanWorkCore?.client;
      if (!client) return [];
      const rows = [];
      if (this.profile.recordTypes.includes('job_pack') && client.listJobPacks) {
        try { rows.push(...(await client.listJobPacks()).map(row => ({ ...row, __type: 'job_pack' }))); } catch (_) {}
      }
      for (const type of this.profile.recordTypes.filter(type => type !== 'job_pack')) {
        try {
          const found = await client.listRecords?.(type);
          if (Array.isArray(found)) rows.push(...found.map(row => ({ ...row, __type: type })));
        } catch (_) {}
      }
      const unique = new Map();
      rows.forEach((row, index) => unique.set(`${row.__type}:${row.id ?? row.key ?? index}`, row));
      return [...unique.values()].slice(0, 12);
    }

    async refresh() {
      this.loading = true;
      this.render();
      this.records = await this.loadRecords();
      this.loading = false;
      this.render();
    }

    render() {
      const nav = this.schema?.navigation?.primary || [];
      const active = nav.find(item => item.id === this.view);
      const title = active?.label || humanise(this.view) || this.profile.headline;
      const widgets = this.schema?.home?.widgets || [];
      const prompts = this.schema?.chat?.suggested_prompts || [];
      const pending = Number(window.TitanSettings?.status?.()?.pending || 0);
      const records = this.records;

      this.element.innerHTML = `
        <div class="titan-workspace__heading">
          <div><span class="titan-workspace__eyebrow">${escapeHtml(this.schema?.identity?.name || 'Titan Zero')}</span><h2>${escapeHtml(title)}</h2></div>
          <button type="button" data-titan-action="refresh" class="titan-workspace__refresh" aria-label="Refresh local records">↻</button>
        </div>
        <div class="titan-workspace__status">
          <span>${navigator.onLine ? 'Online' : 'Offline-ready'}</span>
          <span>${records.length} local record${records.length === 1 ? '' : 's'}</span>
          <span>${pending} pending</span>
        </div>
        ${this.loading ? '<div class="titan-workspace__loading">Loading local WorkCore data…</div>' : ''}
        <section class="titan-workspace__hero">
          <div><p>${escapeHtml(this.profile.headline)}</p><strong>${records.length ? `${records.length} records ready on this device` : escapeHtml(this.profile.empty)}</strong></div>
          <div class="titan-workspace__actions">${this.profile.actions.map(action => `<button type="button" data-titan-action="${safeDataValue(action)}">${escapeHtml(action)}</button>`).join('')}</div>
        </section>
        <section class="titan-workspace__widgets" aria-label="Workspace summary">
          ${widgets.slice(0, 4).map((widget, index) => `<article><span>${escapeHtml(humanise(widget))}</span><strong>${escapeHtml(this.widgetValue(widget, index))}</strong><small>${escapeHtml(this.widgetHint(widget))}</small></article>`).join('')}
        </section>
        <section class="titan-workspace__records">
          <header><h3>${records.length ? 'Local WorkCore records' : 'Ready for WorkCore data'}</h3><span>${escapeHtml(title)}</span></header>
          ${records.length ? records.slice(0, 6).map(record => this.recordCard(record)).join('') : `<div class="titan-workspace__empty"><strong>${escapeHtml(this.profile.empty)}</strong><p>Connect or sync WorkCore to populate this screen. Actions created offline remain on this device until confirmed by Laravel.</p><button type="button" data-titan-action="Sync%20now">Sync now</button></div>`}
        </section>
        ${prompts.length ? `<section class="titan-workspace__prompts"><h3>Ask Titan</h3>${prompts.slice(0, 3).map(prompt => `<button type="button" data-titan-action="${safeDataValue(`prompt:${prompt}`)}">${escapeHtml(prompt)}</button>`).join('')}</section>` : ''}
      `;
    }

    widgetValue(widget, index) {
      const matches = this.records.filter(record => JSON.stringify(record).toLowerCase().includes(String(widget).split('_')[0])).length;
      if (matches) return String(matches);
      if (widget.includes('pending')) return String(Number(window.TitanSettings?.status?.()?.pending || 0));
      if (widget.includes('next') && this.records[0]) return safeText(firstValue(this.records[0], ['scheduled_at','start_at','date','status']), 'Ready');
      return this.records.length ? String(Math.max(0, this.records.length - index)) : '—';
    }

    widgetHint(widget) {
      if (widget.includes('pending')) return 'Awaiting server confirmation';
      if (widget.includes('alert') || widget.includes('exception')) return 'Needs attention';
      return navigator.onLine ? 'Updated from local projection' : 'Available offline';
    }

    recordCard(record) {
      const id = safeText(firstValue(record, ['id','resource_id','key']), 'local');
      const title = safeText(firstValue(record, ['title','name','reference','job.title','work_order.title','customer.name']), `${humanise(record.__type)} ${id}`);
      const status = safeText(firstValue(record, ['status','state','sync_status']), 'Local');
      const subtitle = safeText(firstValue(record, ['customer.name','premises.address','address','description','updated_at']), humanise(record.__type));
      return `<button type="button" class="titan-workspace__record" data-record-id="${safeDataValue(id)}"><span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(subtitle)}</small></span><em>${escapeHtml(humanise(status))}</em></button>`;
    }

    async performAction(action) {
      if (action === 'refresh') return this.refresh();
      if (action === 'Sync now') {
        await window.TitanWorkCore?.client?.sync?.();
        return this.refresh();
      }
      if (action.startsWith('prompt:')) {
        const prompt = action.slice(7);
        window.dispatchEvent(new CustomEvent('titan:prompt-requested', { detail: { prompt, application: this.template, template: this.template, view: this.view } }));
        const message = document.querySelector('[x-ref="message"]');
        if (message) { message.value = prompt; message.dispatchEvent(new Event('input', { bubbles: true })); message.focus(); }
        return;
      }
      if (/capture|scan|incident/i.test(action)) {
        window.dispatchEvent(new CustomEvent('workcore:open-field-workspace', { detail: { action, application: this.template, template: this.template } }));
      }
      window.dispatchEvent(new CustomEvent('titan:operational-action', { detail: { action, application: this.template, template: this.template, view: this.view, authority: 'proposal-only' } }));
    }

    openRecord(id) {
      const record = this.records.find(row => String(row.id ?? row.resource_id ?? row.key) === String(id));
      window.dispatchEvent(new CustomEvent('titan:record-opened', { detail: { application: this.template, template: this.template, view: this.view, id, record, authority: 'local-projection' } }));
    }
  }

  const boot = () => document.querySelectorAll('[data-titan-operational]').forEach(el => {
    if (!el.__titanWorkspace) el.__titanWorkspace = new TitanOperationalWorkspace(el);
  });
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', boot) : boot();
  window.TitanOperationalScreens = { APP_PROFILES, LEGACY_APPLICATIONS, canonicalApplication, boot, escapeHtml, safeDataValue };
})();
