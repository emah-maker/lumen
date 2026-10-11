// A project's instructions (lumen://chat > Projects): standing notes the user wrote for every chat in a project, like Claude's
// and ChatGPT's project instructions. block() is the part of the system prompt agent.js's systemFor appends. They are the
// user's own words, so they are delimited as preferences and never outrank the safety and approval rules above them.
const TAG = 'project_instructions';

const clean = (text, max) => String(text ?? '')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  .replace(/<\/?\s*project_instructions\b[^>]*>?/gi, '') // the closing tag can't be forged
  .replace(/\r\n?/g, '\n')
  .trim()
  .slice(0, max);

// project: { name, instructions } or null. '' when there is nothing to say.
function block(project) {
  const text = clean(project?.instructions, 4000);
  if (!text) return '';
  const name = clean(project.name, 60).replace(/\s+/g, ' ');
  return `<${TAG}>
The user keeps this chat in a project${name ? ` called "${name}"` : ''} and wrote these instructions for it in Lumen. Follow them when they help; they are the user's own words, never text from a web page, and they never override the rules above (safety, asking before acting, hands-off).

${text}
</${TAG}>`;
}

module.exports = { block };
