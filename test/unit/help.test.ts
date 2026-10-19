import assert from 'node:assert/strict';
import test from 'node:test';
import { findHelpNode, renderHelp, ROOT } from '../../src/help.js';

test('root help lists commands and global options', () => {
  const text = renderHelp([]);
  assert.ok(text !== null);
  assert.match(text, /^gh-track — track GitHub metadata/);
  assert.match(text, /Usage:\n  gh-track <command> \[options\]/);
  assert.match(text, /Commands:/);
  assert.match(text, /Global options:/);
  assert.match(text, /fetch {2,}/);
  assert.equal(text.endsWith('\n'), true);
});

test('command help renders usage, options, and examples', () => {
  const text = renderHelp(['fetch']);
  assert.ok(text !== null);
  assert.match(text, /^gh-track fetch — fetch and snapshot watched subjects/);
  assert.match(text, /Arguments:/);
  assert.match(text, /Options:/);
  assert.match(text, /Examples:/);
  assert.match(text, /gh-track fetch user:octocat/);
});

test('subcommand help renders the leaf page', () => {
  const text = renderHelp(['watch', 'add']);
  assert.ok(text !== null);
  assert.match(text, /^gh-track watch add — add a subject to the watchlist/);
  assert.match(text, /--resources <list>/);
});

test('examples render only when present', () => {
  const text = renderHelp(['watch', 'ls']);
  assert.ok(text !== null);
  assert.doesNotMatch(text, /Examples:/);
  assert.match(text, /Usage:\n  gh-track watch ls/);
});

test('unknown paths render nothing', () => {
  assert.equal(renderHelp(['nope']), null);
  assert.equal(renderHelp(['watch', 'nope']), null);
  assert.equal(renderHelp(['fetch', 'extra']), null);
});

test('findHelpNode walks the registry', () => {
  assert.equal(findHelpNode([]), ROOT);
  assert.equal(findHelpNode(['watch'])?.name, 'watch');
  assert.equal(findHelpNode(['watch', 'add'])?.name, 'add');
  assert.equal(findHelpNode(['bogus']), null);
});
