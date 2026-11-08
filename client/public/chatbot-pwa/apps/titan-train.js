(() => {
  class TitanTrainClient {
    constructor(options = {}) {
      this.baseUrl = String(options.baseUrl || window.location.origin).replace(/\/$/, '');
      this.token = options.token || null;
      this.companyId = options.companyId || null;
    }
    setContext({ token, companyId } = {}) {
      if (token) this.token = token;
      if (companyId) this.companyId = companyId;
      return this;
    }
    headers(extra = {}) {
      const headers = { Accept: 'application/json', 'Content-Type': 'application/json', ...extra };
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      if (this.companyId) headers['X-Titan-Company'] = String(this.companyId);
      return headers;
    }
    async request(path, options = {}) {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        credentials: options.credentials || 'include',
        headers: this.headers(options.headers || {}),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || `Titan Train request failed (${response.status}).`);
      return payload.data ?? payload;
    }
    bootstrap() { return this.request('/api/v1/titan-train/pwa/bootstrap'); }
    assignments() { return this.request('/api/v1/titan-train/assignments'); }
    assignment(id) { return this.request(`/api/v1/titan-train/assignments/${encodeURIComponent(id)}`); }
    completeLesson(assignmentId, lessonId) {
      return this.request(`/api/v1/titan-train/assignments/${encodeURIComponent(assignmentId)}/lessons/${encodeURIComponent(lessonId)}/complete`, { method: 'POST', body: '{}' });
    }
    startAssessment(assignmentId, assessmentId) {
      return this.request(`/api/v1/titan-train/assignments/${encodeURIComponent(assignmentId)}/assessments/${encodeURIComponent(assessmentId)}/start`, { method: 'POST', body: '{}' });
    }
    submitAttempt(attemptId, answers) {
      return this.request(`/api/v1/titan-train/attempts/${encodeURIComponent(attemptId)}/submit`, { method: 'POST', body: JSON.stringify({ answers }) });
    }
  }
  const client = new TitanTrainClient({
    token: window.TitanAuth?.token?.() || window.TitanAuth?.token || null,
    companyId: window.TitanCompany?.id?.() || window.TitanCompany?.id || null,
  });
  window.TitanTrain = { client, TitanTrainClient };
  window.dispatchEvent(new CustomEvent('titan:app-registered', {
    detail: { id: 'titan-train', name: 'Titan Train', manifest: '/chatbot-pwa/apps/titan-train.json', launchUrl: '/train', onlineOnly: true, client },
  }));
})();
