// Pure DOM/ElementHandle fixture: executes the production page callbacks. It
// has no browser, network, clock override, Pro click or model-switch operation.
export function modelControlsMenu(options = {}) {
  const events = { reveals: 0, hovers: 0, disposed: 0, submissions: 0, modelChanges: 0 };
  const all = [];
  const document = { defaultView: { getComputedStyle: node => ({ display: node.visible ? 'block' : 'none', visibility: 'visible', opacity: '1' }) },
    querySelectorAll: selector => selector === '[id]' ? all.filter(node => node.hasAttribute('id')) : [] };
  class Element {
    constructor(attrs, text = '', parent = null, visible = true) {
      this.attrs = { ...attrs }; this.textContent = text; this.parentElement = parent; this.visible = visible;
      this.isConnected = true; this.ownerDocument = document; this.hidden = false; all.push(this);
    }
    get id() { return this.attrs.id; }
    getAttribute(key) { return this.attrs[key] ?? null; }
    hasAttribute(key) { return Object.hasOwn(this.attrs, key); }
    closest() { for (let node = this.parentElement; node; node = node.parentElement) if (node.attrs.role === 'menu') return node; return null; }
    querySelectorAll(selector) {
      if (selector !== '[role="menuitemradio"]') return [];
      return all.filter(node => node.attrs.role === 'menuitemradio' && node.isConnected
        && (() => { for (let parent = node.parentElement; parent; parent = parent.parentElement) if (parent === this) return true; return false; })());
    }
    getClientRects() { return this.visible && this.isConnected ? [{}] : []; }
  }
  const root = new Element({ role: options.rootRole ?? 'menu' });
  const row = new Element({ role: 'menuitemradio', 'aria-disabled': 'true', ...options.rowAttrs }, options.rowText ?? 'Pro', root, !options.hidden);
  const tip = new Element({ id: 'tip', role: 'tooltip', ...options.tipAttrs }, options.reason ?? '已达限额。请在明天 14:54 后重试。', null, options.tooltipVisible !== false);
  if (options.duplicate) new Element({ role: 'menuitemradio', 'aria-disabled': 'true' }, 'Pro', root);
  if (options.nested) row.parentElement = new Element({ role: 'menu' }, '', root);
  if (options.duplicateId) new Element({ id: 'tip', role: 'tooltip' }, 'unrelated', null);
  if (options.secondTooltip) new Element({ id: 'second', role: 'tooltip' }, 'other', null);
  if (options.unrelatedQuota) new Element({ id: 'unrelated', role: 'tooltip' }, '已达限额。', null);
  class Handle {
    constructor(value) { this.value = value; }
    asElement() { return this.value instanceof Element ? this : null; }
    evaluate(fn, arg) { return fn(this.value, arg instanceof Handle ? arg.value : arg); }
    async evaluateHandle(fn, arg) { return new Handle(await this.evaluate(fn, arg)); }
    async isVisible() { return this.value.visible; }
    async waitForElementState() { if (!this.value.visible || !this.value.isConnected) throw Error('not-visible'); }
    async hover() {
      events.hovers++;
      if (options.hoverError) throw Error('hover failed');
      row.attrs['aria-describedby'] = options.describedBy ?? (options.secondTooltip ? 'tip second' : 'tip');
      if (options.onHover) options.onHover({ row, root, tip, Element });
    }
    async dispose() { events.disposed++; }
  }
  const menu = { async elementHandle() { return new Handle(root); }, async evaluateHandle(fn) { return new Handle(await fn(root)); } };
  const revealModelList = async received => {
    if (received !== menu) throw Error('wrong menu'); events.reveals++;
    if (options.revealError) throw Error('view unavailable'); row.visible = true;
  };
  return { menu, revealModelList, events, root, row, tip };
}
