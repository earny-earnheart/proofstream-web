// What the support chat is allowed to know. Every answer the assistant gives must come
// from here, so keep it in step with the homepage FAQ (public/landing.html), the Terms of
// Use and the Privacy Policy. tests/support.test.mjs fails if a FAQ question on the
// homepage is missing from this list.

export const SUPPORT_EMAIL = 'support@proofstreamapp.com';

// Each entry: the question as the homepage asks it, the answer, and the words a visitor
// might type, used only by the no-AI fallback when no Claude API key is configured.
export const FAQ = [
  {
    q: 'Is ProofStream free?',
    a: 'Yes, during this preview. You can create an account with your email or Google and use the workspace at no charge. ProofStream does not collect royalties or take payments. If paid plans are ever introduced, ProofStream will say so clearly before anything is charged.',
    keywords: ['free', 'cost', 'price', 'pricing', 'pay', 'charge', 'plan', 'subscription', 'money'],
  },
  {
    q: 'Are my files uploaded?',
    a: 'No. When you fingerprint a draft, your browser computes a SHA-256 hash of the file on your own device. The file never leaves your device. ProofStream stores only the fingerprint (a fixed-length string that cannot be turned back into your file), the time set by ProofStream\'s server, and the details you choose to enter. Evidence for a verification request is also fingerprinted on your device, not uploaded.',
    keywords: ['upload', 'uploaded', 'files', 'stored', 'store', 'privacy', 'private', 'safe', 'device', 'leave'],
  },
  {
    q: 'What is a fingerprint?',
    a: 'A fingerprint is a SHA-256 hash of a file, computed in your browser. It is a unique string for that exact sequence of bytes. If you later drop in the same file, a matching fingerprint shows it is byte-for-byte the version you saved. Change even a little and the fingerprint changes. It identifies a file, does not describe its contents, and cannot be reversed to rebuild the file.',
    keywords: ['fingerprint', 'hash', 'sha', 'sha-256', 'hashing', 'match', 'matching'],
  },
  {
    q: 'Is this proof of legal ownership or copyright?',
    a: 'No. A fingerprint or a timestamp is not proof of legal ownership or copyright. ProofStream is a record-keeping tool. It does not register copyright, give legal advice, or decide who owns a work. You remain responsible for the rights in the work you fingerprint and the claims you record.',
    keywords: ['copyright', 'ownership', 'own', 'legal', 'lawyer', 'court', 'proof', 'register copyright', 'evidence'],
  },
  {
    q: 'Does ProofStream issue ISRCs?',
    a: 'No. SoundExchange and IFPI-authorised agencies issue ISRCs. ProofStream only records the ISRCs you already have, along with the splits, roles and territories you enter, and checks that the splits add up to 100%. It does not assign, generate or sell ISRCs, and it does not bundle UPCs.',
    keywords: ['isrc', 'isrcs', 'upc', 'code', 'soundexchange', 'ifpi', 'splits', 'split'],
  },
  {
    q: 'What does "on-chain" mean, and what is Sepolia?',
    a: 'When a ProofStream administrator verifies a version of a recording claim, ProofStream writes a cryptographic hash of that claim\'s record to a public smart contract (the ProofStreamRegistry). The anchor is a hash, not your file, name or email. Blockchain records are public and permanent: an anchored hash cannot be changed or deleted, even if you delete your account. While ProofStream is in preview, anchoring runs on Ethereum\'s Sepolia test network, not mainnet. If you do not want a claim anchored, do not request its verification.',
    keywords: ['chain', 'on-chain', 'blockchain', 'sepolia', 'ethereum', 'anchor', 'anchored', 'anchoring', 'crypto', 'wallet', 'smart contract'],
  },
  {
    q: 'Who is behind ProofStream?',
    a: 'ProofStream is a product of Pantheon Consulting Group, Inc., a Wyoming corporation. The company operates the service from the United States.',
    keywords: ['who', 'company', 'behind', 'owner', 'pantheon', 'wyoming', 'about'],
  },
  {
    q: 'How do I delete my data?',
    a: `Email ${SUPPORT_EMAIL} from the address on your account and ask for deletion, or use the account-deletion option in the workspace if it is available. Deleting an account removes your registration, projects, sign-in identities, links and recording claims from ProofStream's database. Backups roll off on the provider's normal schedule, and limited records may be kept where the law requires it. On-chain anchors cannot be deleted.`,
    keywords: ['delete', 'deletion', 'remove', 'close account', 'erase', 'data'],
  },
  {
    q: 'How do I get support?',
    a: `Email ${SUPPORT_EMAIL}.`,
    keywords: ['support', 'help', 'contact', 'email', 'human', 'person', 'agent', 'talk'],
  },
  {
    q: 'Do you work with labels and catalogs?',
    a: `Not in this preview. ProofStream is for independent creators first. A later track for labels and catalogs is planned but not available yet, with no promised features, pricing or date. Labels that want to hear when it opens can email ${SUPPORT_EMAIL}.`,
    keywords: ['label', 'labels', 'catalog', 'catalogs', 'distributor', 'enterprise', 'company account'],
  },
];

// How the site works, in plain facts. Only what the live site actually does.
export const GUIDE = [
  ['Creating an account', 'Go to proofstreamapp.com/register, or press "Create a free account" on the homepage. Sign up with Google ("Continue with Google") or with your name, email and a password of at least 10 characters. A quick bot check runs on the form. ProofStream emails a link to confirm your address; confirming keeps the account recoverable.'],
  ['Signing in', 'Go to proofstreamapp.com/register?mode=signin, or press "Sign in" at the top of the homepage, then use Google or your email and password.'],
  ['Forgotten password', 'On the sign-in form, press "Forgot your password?" and enter your email. If the account exists, ProofStream emails a link to set a new password. Setting a new password signs you out on every device.'],
  ['Confirmation email not received', 'Check spam or promotions. In the workspace, a banner offers "Send the link again". If it still does not arrive, email support.'],
  ['Fingerprinting your music or any file', 'After signing in, create a project (give it a name and pick a discipline: music, design, writing, film or software). Then choose a file: its SHA-256 fingerprint is computed in your browser and saved with the time set by ProofStream\'s server. The file itself never leaves your device. Repeat for each new version to build a timeline.'],
  ['Checking a file later', 'Drop the same file into the workspace later. If the fingerprint matches, it is byte-for-byte the version you saved.'],
  ['Exporting your records', 'In a project, use "Export project record" to download a JSON copy of your fingerprints and record details. It does not include your original files.'],
  ['Recordings, ISRCs and splits', 'In the workspace you can add a recording with an ISRC you already have, its title, artist and duration, and the splits for each rights holder, role and territory. Shares must add up to 100%; territory WW means worldwide. The audio file is fingerprinted on your device, never uploaded (up to 500 MB). Changing splits later creates a new claim version; earlier versions stay on the record.'],
  ['Verification', 'You can ask ProofStream to verify a recording claim with evidence such as a signed split sheet, a distributor statement or a registrant letter. Each evidence file is fingerprinted on your device and only its fingerprint is sent (1 to 10 files, up to 100 MB each). Keep the originals; ProofStream may ask to see them. A verified claim is anchored on-chain as a hash.'],
  ['Looking up an ISRC record', 'Looking up the record for an ISRC is for signed-in members and shows verified claims only.'],
  ['Privacy and terms', 'The Privacy Policy is at proofstreamapp.com/privacy and the Terms of Use are at proofstreamapp.com/terms.'],
];

// The single block of reference text the assistant answers from.
export function knowledgeText() {
  const faq = FAQ.map(entry => `Q: ${entry.q}\nA: ${entry.a}`).join('\n\n');
  const guide = GUIDE.map(([title, body]) => `${title}: ${body}`).join('\n');
  return `# ProofStream FAQ\n\n${faq}\n\n# How to use ProofStream\n\n${guide}\n\n# Contact\n\nSupport email: ${SUPPORT_EMAIL}. Website: https://proofstreamapp.com`;
}
