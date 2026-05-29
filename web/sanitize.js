const fs = require('fs');
const path = require('path');

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(function(file) {
    file = path.join(dir, file);
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) {
      results = results.concat(walk(file));
    } else {
      if (file.endsWith('.ts')) results.push(file);
    }
  });
  return results;
}

const files = walk('d:/Graph/web/src/app/api');
files.forEach(f => {
  let content = fs.readFileSync(f, 'utf8');
  let original = content;

  // Replace { error: err.message } or { error: error.message }
  content = content.replace(/NextResponse\.json\(\{\s*error:\s*err(?:\.message)?\s*\},/g, "NextResponse.json({ error: 'Internal Server Error' },");
  content = content.replace(/NextResponse\.json\(\{\s*error:\s*error(?:\.message)?\s*\},/g, "NextResponse.json({ error: 'Internal Server Error' },");
  
  if (original !== content) {
    fs.writeFileSync(f, content, 'utf8');
    console.log('Fixed', f);
  }
});
