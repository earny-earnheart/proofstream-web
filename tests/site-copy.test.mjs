import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('homepage uses the approved hero, audience row, caption, FAQ and same-site buttons', () => {
  const html = read('public/landing.html');
  assert.match(html, /FOR INDEPENDENT CREATORS/);
  assert.match(html, /Fingerprint every draft<br>on your device\.<br><em>Keep the proof\.<\/em>/);
  assert.match(html, /For musicians, designers, writers, filmmakers and developers\./);
  assert.match(html, /Free during preview\. Your first project opens next\./);
  assert.equal((html.match(/Create a free account/g) || []).length, 3);
  assert.match(html, /WHO IT'S FOR/);
  assert.match(html, /Built for independent creators\./);
  assert.match(html, /That's ProofShark, ProofStream's mascot\./);
  assert.match(html, /id="faq"/);
  assert.match(html, /href="#faq">FAQ</);
  assert.match(html, /Questions, answered\./);
  for (const question of [
    'Is ProofStream free?',
    'Are my files uploaded?',
    'What is a fingerprint?',
    'Is this proof of legal ownership or copyright?',
    'Does ProofStream issue ISRCs?',
    'what is Sepolia?',
    'Who is behind ProofStream?',
    'How do I delete my data?',
    'How do I get support?',
    'Do you work with labels and catalogs?',
  ]) assert.ok(html.includes(question), question);
  assert.match(html, /Start with a free account\./);
  assert.match(html, /href="\/terms">Terms of Use</);
  assert.doesNotMatch(html, /A home for your creative process/);
  assert.doesNotMatch(html, /Start a project/);
  assert.doesNotMatch(html, /Start your first project/);
  assert.doesNotMatch(html, /↗/);
  assert.doesNotMatch(html, /style=/);
  assert.doesNotMatch(html, /verify\.proofstreamapp\.com/);
});

test('terms page matches the privacy page and omits draft notes', () => {
  const terms = read('public/terms.html');
  const privacy = read('public/privacy.html');
  assert.match(terms, /<title>Terms of Use — ProofStream<\/title>/);
  assert.match(terms, /href="https:\/\/proofstreamapp\.com\/terms"/);
  assert.match(terms, /class="landing-main legal"/);
  assert.match(terms, /PROOFSTREAM · LEGAL/);
  assert.match(terms, /Effective 22 November 2026 · Last updated 22 November 2026/);
  assert.match(terms, /30 N Gould St, Ste R, Sheridan, WY 82801/);
  assert.match(terms, /US \$100/);
  assert.match(terms, /state and federal courts located in Wyoming/);
  assert.match(privacy, /href="\/terms">Terms of Use</);
  assert.match(read('public/landing.html'), /href="\/terms">Terms of Use</);
  assert.match(read('public/index.html'), /href="\/terms">Terms of Use</);
  assert.match(read('public/register.html'), /href="\/terms">Terms of Use</);
  assert.match(read('public/sitemap.xml'), /https:\/\/proofstreamapp\.com\/terms</);
  for (const banned of [
    'Draft for legal review',
    'NOTE TO LEGAL',
    'NOTICE PERIOD DURING PREVIEW',
    'OPTIONAL ARBITRATION',
    'Placeholders and legal notes',
    'verify.proofstreamapp.com',
    'DRAFT FOR LEGAL',
  ]) assert.equal(terms.includes(banned), false, banned);
  assert.doesNotMatch(terms, /style=/);
  assert.doesNotMatch(terms, /<script/);
  assert.doesNotMatch(terms, /↗/);
  assert.doesNotMatch(privacy, /↗/);
});

test('register copy follows the mode and the start=project landing', () => {
  const html = read('public/register.html');
  const js = read('public/register.js');
  assert.match(html, /<title>Create your account — ProofStream<\/title>/);
  assert.match(html, /id="register-subline"/);
  assert.match(js, /Create a free account\./);
  assert.match(js, /Your first project opens next\. Files stay on your device\./);
  assert.match(js, /document\.title = copy\[2\]/);
  assert.match(js, /Create your account \\u2014 ProofStream/);
  assert.match(js, /Sign in \\u2014 ProofStream/);
  assert.match(js, /Reset your password \\u2014 ProofStream/);
  assert.match(js, /Welcome back\./);
  assert.doesNotMatch(js, /↗/);
});
