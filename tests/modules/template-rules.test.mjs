import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defineTemplate,
  renderTemplate,
  TemplateDefinitionError,
  MAX_BODY_LENGTH,
} from '../../server/modules/comms/template-rules.ts';

const COMPANY = 'co-1';

function approvedTemplate(overrides = {}) {
  return defineTemplate({
    id: 'booking-confirmed',
    channel: 'sms',
    body: 'Hi {{first_name}}, your clean is booked for {{slot}}.',
    variables: ['first_name', 'slot'],
    approved: true,
    ...overrides,
  });
}

function defineError(input) {
  try {
    defineTemplate(input);
  } catch (err) {
    return err;
  }
  return null;
}

// ---------- defineTemplate ----------

test('defineTemplate accepts a well-formed approved template and freezes it', () => {
  const t = approvedTemplate();
  assert.equal(t.id, 'booking-confirmed');
  assert.equal(t.approved, true);
  assert.equal(t.allowLinks, false);
  assert.equal(t.allowContact, false);
  assert.ok(Object.isFrozen(t));
  assert.ok(Object.isFrozen(t.variables));
});

test('defineTemplate rejects ids that are not lowercase kebab-case', () => {
  for (const id of ['Booking', 'booking_confirmed', '-leading', 'trailing-', 'double--dash', 'has space', '']) {
    const err = defineError({ id, channel: 'sms', body: 'x', variables: [], approved: true });
    assert.ok(err instanceof TemplateDefinitionError, `expected refusal for id ${JSON.stringify(id)}`);
  }
});

test('defineTemplate rejects an empty or whitespace-only body', () => {
  assert.ok(defineError({ id: 'a', channel: 'sms', body: '', variables: [], approved: true }));
  assert.ok(defineError({ id: 'a', channel: 'sms', body: '   ', variables: [], approved: true }));
});

test('defineTemplate enforces the 1600 character body limit', () => {
  const atLimit = 'a'.repeat(MAX_BODY_LENGTH);
  assert.equal(defineTemplate({ id: 'a', channel: 'sms', body: atLimit, variables: [], approved: true }).body.length, 1600);
  const over = defineError({ id: 'a', channel: 'sms', body: atLimit + 'a', variables: [], approved: true });
  assert.ok(over instanceof TemplateDefinitionError);
});

test('defineTemplate rejects variable names that do not match /^[a-z_]+$/', () => {
  for (const name of ['FirstName', 'first-name', 'name1', 'first name']) {
    const err = defineError({
      id: 'a',
      channel: 'sms',
      body: `{{${name}}}`,
      variables: [name],
      approved: true,
    });
    assert.ok(err instanceof TemplateDefinitionError, `expected refusal for variable ${name}`);
    assert.deepEqual(err.names, [name]);
  }
});

test('defineTemplate refuses a body with a placeholder not listed in variables', () => {
  const err = defineError({
    id: 'a',
    channel: 'sms',
    body: 'Hello {{first_name}} at {{address}}',
    variables: ['first_name'],
    approved: true,
  });
  assert.ok(err instanceof TemplateDefinitionError);
  assert.deepEqual(err.names, ['address']);
});

test('defineTemplate refuses a listed variable that the body never uses', () => {
  const err = defineError({
    id: 'a',
    channel: 'sms',
    body: 'Hello {{first_name}}',
    variables: ['first_name', 'slot'],
    approved: true,
  });
  assert.ok(err instanceof TemplateDefinitionError);
  assert.deepEqual(err.names, ['slot']);
});

test('defineTemplate refuses a non-boolean approved flag', () => {
  assert.ok(defineError({ id: 'a', channel: 'sms', body: 'x', variables: [], approved: 'yes' }));
});

// ---------- renderTemplate: approval ----------

test('renderTemplate refuses an unapproved template', () => {
  const t = approvedTemplate({ approved: false });
  const result = renderTemplate(t, { first_name: 'Ana', slot: 'Monday' }, { company: COMPANY });
  assert.deepEqual(result, { ok: false, reason: 'template_not_approved', names: [] });
});

test('renderTemplate refuses a hand-built object that was never defined', () => {
  const fake = { id: 'a', channel: 'sms', body: 'Hi', variables: [], approved: true };
  const result = renderTemplate(fake, {}, { company: COMPANY });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'template_not_defined');
});

test('renderTemplate requires a company', () => {
  assert.throws(() => renderTemplate(approvedTemplate(), { first_name: 'a', slot: 'b' }, {}), TypeError);
});

// ---------- renderTemplate: variable rules ----------

test('renderTemplate refuses a missing variable and lists its name', () => {
  const result = renderTemplate(approvedTemplate(), { first_name: 'Ana' }, { company: COMPANY });
  assert.deepEqual(result, { ok: false, reason: 'missing_variable', names: ['slot'] });
});

test('renderTemplate lists every missing variable', () => {
  const result = renderTemplate(approvedTemplate(), {}, { company: COMPANY });
  assert.equal(result.reason, 'missing_variable');
  assert.deepEqual(result.names, ['first_name', 'slot']);
});

test('renderTemplate refuses a value that is not declared in variables', () => {
  const result = renderTemplate(
    approvedTemplate(),
    { first_name: 'Ana', slot: 'Monday', address: '1 Main St' },
    { company: COMPANY },
  );
  assert.deepEqual(result, { ok: false, reason: 'unknown_variable', names: ['address'] });
});

test('renderTemplate refuses non-string values', () => {
  const result = renderTemplate(approvedTemplate(), { first_name: 42, slot: 'Monday' }, { company: COMPANY });
  assert.deepEqual(result, { ok: false, reason: 'invalid_value', names: ['first_name'] });
});

// ---------- renderTemplate: links and contact details ----------

test('renderTemplate refuses a value containing a URL by default', () => {
  const t = defineTemplate({
    id: 'pay-link',
    channel: 'sms',
    body: 'Pay here: {{pay}}',
    variables: ['pay'],
    approved: true,
  });
  for (const pay of ['https://pay.example.com/x', 'see www.example.com', 'shop.example.au/deal']) {
    const result = renderTemplate(t, { pay }, { company: COMPANY });
    assert.deepEqual(result, { ok: false, reason: 'link_not_allowed', names: ['pay'] }, pay);
  }
});

test('renderTemplate allows a URL when the template declares allowLinks', () => {
  const t = defineTemplate({
    id: 'pay-link',
    channel: 'sms',
    body: 'Pay here: {{pay}}',
    variables: ['pay'],
    approved: true,
    allowLinks: true,
  });
  assert.deepEqual(
    renderTemplate(t, { pay: 'https://pay.example.com/x' }, { company: COMPANY }),
    { ok: true, text: 'Pay here: https://pay.example.com/x' },
  );
});

test('renderTemplate refuses an email address unless allowContact is declared', () => {
  const t = approvedTemplate({ body: 'Reply to {{contact}}', variables: ['contact'] });
  const refused = renderTemplate(t, { contact: 'jo@example.com' }, { company: COMPANY });
  assert.deepEqual(refused, { ok: false, reason: 'contact_not_allowed', names: ['contact'] });

  const allowed = defineTemplate({
    id: 'reply-to',
    channel: 'email',
    body: 'Reply to {{contact}}',
    variables: ['contact'],
    approved: true,
    allowContact: true,
  });
  assert.deepEqual(
    renderTemplate(allowed, { contact: 'jo@example.com' }, { company: COMPANY }),
    { ok: true, text: 'Reply to jo@example.com' },
  );
});

test('renderTemplate refuses a phone-like value unless allowContact is declared', () => {
  const t = approvedTemplate({ body: 'Call {{phone}}', variables: ['phone'] });
  for (const phone of ['0412 345 678', '+61 412-345-678', '(03) 9123 4567']) {
    const result = renderTemplate(t, { phone }, { company: COMPANY });
    assert.deepEqual(result, { ok: false, reason: 'contact_not_allowed', names: ['phone'] }, phone);
  }
});

test('renderTemplate does not treat a date or short number as a phone', () => {
  const t = approvedTemplate({ body: 'Due {{when}}', variables: ['when'] });
  assert.deepEqual(
    renderTemplate(t, { when: '2026-11-03 at 10:30' }, { company: COMPANY }),
    { ok: true, text: 'Due 2026-11-03 at 10:30' },
  );
});

// ---------- renderTemplate: plain text insertion ----------

test('renderTemplate inserts an HTML value as plain text without escaping or stripping', () => {
  const t = approvedTemplate();
  const result = renderTemplate(
    t,
    { first_name: '<img src=x onerror=alert(1)>', slot: '<b>Monday</b> & "later"' },
    { company: COMPANY },
  );
  assert.deepEqual(result, {
    ok: true,
    text: 'Hi <img src=x onerror=alert(1)>, your clean is booked for <b>Monday</b> & "later".',
  });
});

test('renderTemplate does not re-expand placeholders inside values or interpret $ patterns', () => {
  const t = approvedTemplate();
  const result = renderTemplate(
    t,
    { first_name: '{{slot}} $& $1', slot: 'noon' },
    { company: COMPANY },
  );
  assert.deepEqual(result, { ok: true, text: 'Hi {{slot}} $& $1, your clean is booked for noon.' });
});
