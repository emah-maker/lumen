// Evaluation sessions where tabs show FILES (see organize-eval.js for the format): course PDFs and slides next to Canvas and Gradescope,
// a Downloads folder of PDFs and spreadsheets, PDFs on the web, and a project's files from disk. Tabs are built the way Lumen sees them:
//   pdf()    a local PDF in Lumen's viewer (lumen-pdf://app/viewer.html?u=<file: address>); the title is the file name until the viewer reads the PDF's own
//   deck()   a PowerPoint deck in the slide viewer (renderer/slides.html?u=<file: address>)
//   file()   a file opened from disk (file://), titled by Chromium with its name
//   web()    a PDF from the web in the viewer (the address bar shows the web address)
// `text` is the first-page snippet the viewer reads (main.js readPageText); only some files have one.
const T = (title, url, group, text) => (text ? { title, url, group, text } : { title, url, group });
const fileUrl = (winPath) => encodeURI(`file:///${winPath.replace(/\\/g, '/')}`);
const nameOf = (winPath) => winPath.split('\\').pop();
const pdf = (winPath, group, { title, text } = {}) => T(title || nameOf(winPath), `lumen-pdf://app/viewer.html?u=${encodeURIComponent(fileUrl(winPath))}`, group, text);
const deck = (winPath, group, { text } = {}) => T(nameOf(winPath), `file:///C:/Program%20Files/Lumen/resources/app/src/renderer/slides.html?u=${encodeURIComponent(fileUrl(winPath))}`, group, text);
const file = (winPath, group, { title, text } = {}) => T(title || nameOf(winPath), fileUrl(winPath), group, text);
const web = (url, group, { title, text } = {}) => T(title || decodeURIComponent(url.split('/').pop()), `lumen-pdf://app/viewer.html?u=${encodeURIComponent(url)}`, group, text);

const H = 'C:\\Users\\sam';

const courses = {
  name: '[eval] files: student with course PDFs and slides beside Canvas',
  names: { me: /me ?2350|thermo/i, cs: /cs ?3500|object|design/i, writing: /engw ?1111|writing|essay/i },
  tabs: [
    T('ME 2350 Thermodynamics - Canvas', 'https://canvas.northeastern.edu/courses/2350', 'me'),
    T('Assignment 4 - ME 2350 - Gradescope', 'https://www.gradescope.com/courses/881204/assignments/4', 'me'),
    pdf(`${H}\\Documents\\Northeastern\\ME 2350\\Lecture 05 - Entropy.pdf`, 'me', { text: 'ME 2350 Thermodynamics. Lecture 5: entropy and the second law. Prof. Alvarez.' }),
    deck(`${H}\\Documents\\Northeastern\\ME 2350\\Week 6 Review.pptx`, 'me'),
    pdf(`${H}\\Downloads\\ME2350_HW4_solutions.pdf`, 'me'),
    T('CS 3500 Object-Oriented Design - Canvas', 'https://canvas.northeastern.edu/courses/3500', 'cs'),
    T('Lab 3 - CS 3500 - Gradescope', 'https://www.gradescope.com/courses/881977/assignments/9', 'cs'),
    pdf(`${H}\\Documents\\Northeastern\\CS 3500\\Lecture 7 - Interfaces.pdf`, 'cs', { text: 'CS 3500 Object-Oriented Design. Interfaces and polymorphism.' }),
    deck(`${H}\\Documents\\Northeastern\\CS 3500\\polymorphism-week7.pptx`, 'cs'),
    file(`${H}\\Documents\\Northeastern\\CS 3500\\notes.txt`, 'cs', { text: 'CS 3500 lab 3 notes: strategy pattern, visitor, double dispatch' }),
    T('ENGW 1111 First-Year Writing - Canvas', 'https://canvas.northeastern.edu/courses/1111', 'writing'),
    pdf(`${H}\\Downloads\\ENGW1111_essay2_rubric.pdf`, 'writing', { text: 'ENGW 1111 First-Year Writing. Essay 2 rubric.' }),
    T('Inbox (4) - Gmail', 'https://mail.google.com/mail/u/0/#inbox', null),
    T('YouTube', 'https://www.youtube.com/', null),
    pdf(`${H}\\Downloads\\boarding-pass.pdf`, null),
  ],
};

const downloads = {
  name: '[eval] files: Downloads PDFs and spreadsheets',
  names: { tax: /tax|w-2|1099/i, lease: /lease|apartment|rent/i, trip: /lisbon|trip|flight/i, budget: /budget|expens/i },
  tabs: [
    pdf(`${H}\\Downloads\\W-2_2025.pdf`, 'tax', { text: 'Form W-2 Wage and Tax Statement 2025. Copy B, to be filed with employee federal tax return.' }),
    pdf(`${H}\\Downloads\\1099-INT_chase_2025.pdf`, 'tax', { text: '1099-INT interest income 2025 tax year' }),
    pdf(`${H}\\Downloads\\tax-return-2025-draft.pdf`, 'tax'),
    T('Tax withholding estimator - IRS', 'https://www.irs.gov/individuals/tax-withholding-estimator', 'tax'),
    T('TurboTax: 2025 federal tax return', 'https://turbotax.intuit.com/tax-tools/', 'tax'),
    file(`${H}\\Downloads\\budget-2026.xlsx`, 'budget'),
    file(`${H}\\Downloads\\expenses_march.xlsx`, 'budget'),
    pdf(`${H}\\Downloads\\Lease_agreement_Maple_St.pdf`, 'lease', { text: 'Residential lease agreement 41 Maple Street apartment 3B' }),
    pdf(`${H}\\Downloads\\Maple Street apartment inspection report.pdf`, 'lease'),
    T('Renters insurance quote - Lemonade', 'https://www.lemonade.com/renters', 'lease'),
    pdf(`${H}\\Downloads\\Flight confirmation Lisbon.pdf`, 'trip', { text: 'Booking confirmation. Flight BOS to Lisbon LIS' }),
    pdf(`${H}\\Downloads\\Lisbon hotel booking.pdf`, 'trip'),
    T('Lisbon travel guide - Lonely Planet', 'https://www.lonelyplanet.com/portugal/lisbon', 'trip'),
    T('Inbox - Gmail', 'https://mail.google.com/mail/u/0/#inbox', null),
    file(`${H}\\Downloads\\IMG_2231.jpg`, null, { title: 'IMG_2231.jpg (3024×4032)' }),
  ],
};

const papers = {
  name: '[eval] files: papers as web PDFs beside the library',
  names: { crispr: /crispr|gene|editing/i, transformers: /transformer|attention|language model/i },
  tabs: [
    web('https://arxiv.org/pdf/1706.03762', 'transformers', { title: 'Attention Is All You Need' }),
    web('https://arxiv.org/pdf/2005.14165', 'transformers', { title: 'Language Models are Few-Shot Learners' }),
    T('The Illustrated Transformer - Jay Alammar', 'https://jalammar.github.io/illustrated-transformer/', 'transformers'),
    T('Attention mechanism explained - Wikipedia', 'https://en.wikipedia.org/wiki/Attention_(machine_learning)', 'transformers'),
    web('https://www.nature.com/articles/s41586-019-1711-4.pdf', 'crispr', { title: 'Base editing with CRISPR in human cells' }),
    web('https://www.ncbi.nlm.nih.gov/pmc/articles/PMC6000/pdf/nihms-crispr-off-target.pdf', 'crispr', { title: 'CRISPR off-target effects review' }),
    T('CRISPR gene editing - Wikipedia', 'https://en.wikipedia.org/wiki/CRISPR_gene_editing', 'crispr'),
    T('Spotify - Web Player', 'https://open.spotify.com/', null),
  ],
};

const project = {
  name: '[eval] files: a project open from disk beside its web tabs',
  names: { billing: /billing|invoice/i, kitchen: /kitchen|remodel/i },
  tabs: [
    file(`${H}\\dev\\billing-service\\README.md`, 'billing', { text: 'billing-service: invoices, payments and Stripe webhooks' }),
    file(`${H}\\dev\\billing-service\\src\\invoice.py`, 'billing', { text: 'Invoice model and PDF rendering for the billing service' }),
    file(`${H}\\dev\\billing-service\\tests\\test_invoice.py`, 'billing'),
    T('Pull requests - acme/billing-service', 'https://github.com/acme/billing-service/pulls', 'billing'),
    T('Stripe webhooks: invoice.paid - Stripe Docs', 'https://docs.stripe.com/webhooks', 'billing'),
    pdf(`${H}\\Documents\\Kitchen remodel\\cabinet-quote-Home Depot.pdf`, 'kitchen'),
    pdf(`${H}\\Documents\\Kitchen remodel\\contractor_estimate.pdf`, 'kitchen', { text: 'Kitchen remodel estimate: cabinets, countertops, labor' }),
    T('Quartz vs granite countertops - Wirecutter', 'https://www.nytimes.com/wirecutter/reviews/quartz-granite-countertops/', 'kitchen'),
    T('Spotify - Web Player', 'https://open.spotify.com/', null),
  ],
};

module.exports = { sessions: [courses, downloads, papers, project] };
