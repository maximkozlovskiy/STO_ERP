import '@testing-library/jest-dom';

// jsdom does not implement Element.prototype.scrollIntoView — stub it so components
// that scroll the active item into view (CommandPalette, Select, list virtualizers)
// do not crash during render.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function () { /* no-op for jsdom */ };
}
