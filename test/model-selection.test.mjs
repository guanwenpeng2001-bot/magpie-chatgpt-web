import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnDriver } from '../backend/turn.mjs';

function pickerFixture() {
  let view = 'effort';
  let selected;
  const rows = ['GPT-6', 'GPT-5.6 Sol', 'GPT-5.5\nLeaving on October 14'].map(text => ({
    getAttribute: async () => null,
    innerText: async () => text,
    click: async () => { selected = text.split('\n')[0]; },
  }));
  const collection = items => ({ filter: () => collection(items), count: async () => items.length, all: async () => items });
  const menu = { filter() { return this; }, first() { return this; }, waitFor: async () => {} };
  const trigger = { click: async () => { view = 'effort'; }, count: async () => 1, filter() { return this; }, waitFor: async () => {}, first() { return this; } };
  const toggle = { click: async () => { view = 'models'; }, count: async () => view === 'effort' ? 1 : 0, filter() { return this; } };
  return {
    state: () => ({ view, selected }),
    page: {
      locator(selector) {
        if (selector === '[data-model-id]') return collection([]);
        if (selector === '[role="menu"]') return menu;
        if (selector.includes('data-codex-intelligence-trigger') && selector.includes('aria-haspopup')) return trigger;
        if (selector.includes('data-model-picker-view-toggle')) return toggle;
        throw new Error('Unrecognized structural selector');
      },
      getByRole(role) {
        if (role === 'button') return collection([]);
        if (role === 'menuitemradio') return collection(view === 'models' ? rows : []);
        throw new Error('Unexpected role');
      },
      keyboard: { press: async key => { assert.equal(key, 'Escape'); view = 'closed'; } },
    },
  };
}

for (const [slug, label] of [['gpt-6', 'GPT-6'], ['gpt-5-5', 'GPT-5.5']]) {
  test(`structural picker selects ${slug} without localized trigger text`, async () => {
    const fixture = pickerFixture();
    await TurnDriver.prototype.selectModel.call({}, fixture.page, slug);
    assert.deepEqual(fixture.state(), { view: 'closed', selected: label });
  });
}

for (const slug of ['gpt-6-mini', 'gpt-5-6', 'gpt-5-6-mini']) {
  test(`picker refuses ambiguous or absent mapping for ${slug}`, async () => {
    const fixture = pickerFixture();
    await assert.rejects(TurnDriver.prototype.selectModel.call({}, fixture.page, slug), error => error.code === 'pageShape');
    assert.deepEqual(fixture.state(), { view: 'closed', selected: undefined });
  });
}

test('auto preserves the site default without a per-model claim', async () => {
  const fixture = pickerFixture();
  await TurnDriver.prototype.selectModel.call({}, fixture.page, 'auto');
  assert.deepEqual(fixture.state(), { view: 'effort', selected: undefined });
});

function visibilityFixture(rows) {
  let view = 'effort';
  let selected;
  const entries = rows.map(row => ({
    getAttribute: async () => null,
    innerText: async () => row.text,
    click: async () => { selected = row.text.split('\n')[0]; },
  }));
  const collection = items => ({
    filter: options => collection(options?.visible === true ? items.filter((_, index) => rows[index].visible) : items),
    count: async () => items.length,
    all: async () => items,
  });
  const menu = { filter() { return this; }, first() { return this; }, waitFor: async () => {} };
  const trigger = { click: async () => { view = 'effort'; }, count: async () => 1, filter() { return this; }, waitFor: async () => {}, first() { return this; } };
  const toggle = { click: async () => { view = 'models'; }, count: async () => view === 'effort' ? 1 : 0, filter() { return this; } };
  return {
    state: () => ({ view, selected }),
    page: {
      locator(selector) {
        if (selector === '[data-model-id]') return collection([]);
        if (selector === '[role="menu"]') return menu;
        if (selector.includes('data-codex-intelligence-trigger') && selector.includes('aria-haspopup')) return trigger;
        if (selector.includes('data-model-picker-view-toggle')) return toggle;
        throw new Error('Unrecognized structural selector');
      },
      getByRole(role) {
        if (role === 'button') return collection([]);
        if (role === 'menuitemradio') return collection(view === 'models' ? entries : []);
        throw new Error('Unexpected role');
      },
      keyboard: { press: async key => { assert.equal(key, 'Escape'); view = 'closed'; } },
    },
  };
}

test('picker refuses two visible entries sharing a first-line title', async () => {
  const fixture = visibilityFixture([
    { text: 'GPT-6\nFirst rendering', visible: true },
    { text: 'GPT-6\nSecond rendering', visible: true },
  ]);
  await assert.rejects(TurnDriver.prototype.selectModel.call({}, fixture.page, 'gpt-6'), error => error.code === 'pageShape');
  assert.deepEqual(fixture.state(), { view: 'closed', selected: undefined });
});

test('picker ignores entries the visibility filter excludes', async () => {
  const fixture = visibilityFixture([
    { text: 'GPT-6', visible: true },
    { text: 'GPT-6\nHidden duplicate', visible: false },
  ]);
  await TurnDriver.prototype.selectModel.call({}, fixture.page, 'gpt-6');
  assert.deepEqual(fixture.state(), { view: 'closed', selected: 'GPT-6' });
});
