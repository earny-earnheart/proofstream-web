'use strict';
// Support chat: a "Help" button in the corner that opens a small chat panel. It appears
// only when the server says the chat is on (/api/session → supportChat). Replies are
// shown with textContent, never as HTML. The conversation lives only in this tab.
(async () => {
  const EMAIL = 'support@proofstreamapp.com';
  let session;
  try {
    session = await (await fetch('/api/session', { credentials: 'same-origin' })).json();
  } catch { return; }
  if (!session || !session.supportChat) return;

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };

  const launcher = el('button', 'support-launcher', 'Help');
  launcher.type = 'button';
  launcher.setAttribute('aria-expanded', 'false');
  launcher.setAttribute('aria-controls', 'support-panel');

  const panel = el('section', 'support-panel');
  panel.id = 'support-panel';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'ProofStream support chat');

  const head = el('div', 'support-head');
  head.append(el('strong', '', 'ProofStream help'));
  const close = el('button', 'support-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close support chat');
  head.append(close);

  const log = el('div', 'support-log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'polite');

  const form = el('form', 'support-form');
  const input = el('textarea', 'support-input');
  input.rows = 2;
  input.maxLength = 1000;
  input.placeholder = 'Ask about ProofStream…';
  input.setAttribute('aria-label', 'Your question');
  const send = el('button', 'primary support-send', 'Send');
  send.type = 'submit';
  form.append(input, send);

  const foot = el('p', 'support-foot');
  foot.append('An AI assistant answers from ProofStream\'s FAQ. Don\'t share passwords or personal details. Need a person? ');
  const mail = el('a', '', EMAIL);
  mail.href = 'mailto:' + EMAIL;
  foot.append(mail);

  panel.append(head, log, form, foot);
  document.body.append(launcher, panel);

  const history = [];
  const add = (role, text) => {
    const bubble = el('p', 'support-msg support-' + role, text);
    log.append(bubble);
    log.scrollTop = log.scrollHeight;
    return bubble;
  };
  add('assistant', 'Hi! Ask me how ProofStream works, how to sign up, or how to fingerprint your music.');

  const toggle = open => {
    panel.hidden = !open;
    launcher.setAttribute('aria-expanded', String(open));
    if (open) input.focus(); else launcher.focus();
  };
  launcher.addEventListener('click', () => toggle(panel.hidden));
  close.addEventListener('click', () => toggle(false));
  panel.addEventListener('keydown', event => { if (event.key === 'Escape') toggle(false); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); }
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const question = input.value.trim();
    if (!question || send.disabled) return;
    input.value = '';
    add('user', question);
    history.push({ role: 'user', content: question });
    send.disabled = true;
    const pending = add('assistant', '…');
    pending.classList.add('support-pending');
    try {
      const response = await fetch('/api/support/chat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: history.slice(-12) }),
      });
      const data = await response.json().catch(() => ({}));
      const reply = data.reply || data.error || 'Something went wrong. Please email ' + EMAIL + '.';
      pending.textContent = reply;
      if (data.reply) history.push({ role: 'assistant', content: reply });
      else history.pop();
    } catch {
      pending.textContent = 'You seem to be offline. Please try again, or email ' + EMAIL + '.';
      history.pop();
    } finally {
      pending.classList.remove('support-pending');
      send.disabled = false;
      log.scrollTop = log.scrollHeight;
    }
  });
})();
