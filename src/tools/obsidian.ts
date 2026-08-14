import * as fs from 'fs/promises';
import * as path from 'path';
import { tool } from 'ai';
import { z } from 'zod';
import { isKillSwitchTriggered, logAudit } from '../core/audit';
import { sessionLocalStorage } from '../core/session';
import { getSessionTaint, scanAndTaint, taintSession } from '../core/taint';
import { requestApproval } from '../core/approval';

export async function getVaultPath(): Promise<string> {
  const vault = process.env.OBSIDIAN_VAULT_PATH || './vault';
  const resolved = path.resolve(vault);
  await fs.mkdir(resolved, { recursive: true });
  return resolved;
}

// Sanitize unsafe filename characters
function sanitizeFilename(title: string): string {
  return title.replace(/[^a-zA-Z0-9_\-\sก-๙]/g, '_').trim();
}

// Parse simple YAML frontmatter and markdown body
function parseNote(fileContent: string) {
  const match = fileContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {} as Record<string, any>, body: fileContent };
  }
  
  const yamlStr = match[1];
  const body = match[2];
  const frontmatter: Record<string, any> = {};
  
  yamlStr.split(/\r?\n/).forEach(line => {
    const idx = line.indexOf(':');
    if (idx !== -1) {
      const key = line.substring(0, idx).trim();
      const value = line.substring(idx + 1).trim();
      
      // Parse array e.g. [tag1, tag2]
      if (value.startsWith('[') && value.endsWith(']')) {
        frontmatter[key] = value
          .substring(1, value.length - 1)
          .split(',')
          .map(s => s.trim())
          .filter(Boolean);
      } else {
        frontmatter[key] = value.replace(/^['"]|['"]$/g, ''); // strip quotes
      }
    }
  });
  
  return { frontmatter, body };
}

// Helper to format frontmatter back to string
function stringifyFrontmatter(frontmatter: Record<string, any>): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.join(', ')}]`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

// Helper to recursively get all md files in vault
export async function getVaultFiles(dir: string): Promise<string[]> {
  try {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    const files = await Promise.all(dirents.map(async (dirent) => {
      const res = path.resolve(dir, dirent.name);
      if (dirent.isDirectory()) {
        return getVaultFiles(res);
      }
      return dirent.name.endsWith('.md') ? res : [];
    }));
    return Array.prototype.concat(...files);
  } catch {
    return [];
  }
}

export interface ObsidianNote {
  frontmatter: Record<string, any>;
  title: string;
  body: string;
  links: Set<string>;
  parentLink?: string;
}

export function parseObsidianNote(fileContent: string, defaultTitle: string): ObsidianNote {
  const { frontmatter, body } = parseNote(fileContent);
  
  // Normalize newlines to LF for parsing simplicity
  let text = body.replace(/\r\n/g, '\n');
  
  // 1. Extract `# Title`
  let title = defaultTitle;
  const titleMatch = text.match(/^#\s+(.+)$/m);
  if (titleMatch) {
    title = titleMatch[1].trim();
    // Remove the title line
    text = text.replace(/^#\s+.+$/m, '');
  }
  
  // 2. Extract `up:: [[...]]`
  let parentLink: string | undefined;
  const parentMatch = text.match(/^up::\s*(?:\[\[(.*?)\]\]|(.*?))$/m);
  if (parentMatch) {
    parentLink = (parentMatch[1] || parentMatch[2] || '').trim();
    // Remove the parent line
    text = text.replace(/^up::\s*(?:\[\[.*?\]\]|.*?)$/m, '');
  }
  
  // 3. Extract `## Links` section
  const links = new Set<string>();
  const linksHeaderIdx = text.indexOf('## Links');
  if (linksHeaderIdx !== -1) {
    const afterLinks = text.substring(linksHeaderIdx);
    const lines = afterLinks.split('\n');
    let linksSectionLength = 0;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (i === 0) {
        linksSectionLength += lines[i].length + 1;
        continue;
      }
      
      if (line.startsWith('#') || line.startsWith('up::')) {
        break;
      }
      
      const linkMatch = line.match(/^-\s*\[\[(.*?)\]\]/) || line.match(/^\[\[(.*?)\]\]/);
      if (linkMatch) {
        links.add(linkMatch[1].trim());
      }
      
      if (line.startsWith('-') || line === '') {
        linksSectionLength += lines[i].length + 1;
      } else {
        break;
      }
    }
    
    text = text.substring(0, linksHeaderIdx) + text.substring(linksHeaderIdx + linksSectionLength);
  }
  
  return {
    frontmatter,
    title,
    body: text.trim(),
    links,
    parentLink
  };
}

export function serializeObsidianNote(note: ObsidianNote): string {
  const fm = stringifyFrontmatter(note.frontmatter);
  
  const lines: string[] = [];
  lines.push(fm);
  lines.push(`# ${note.title}`);
  lines.push('');
  if (note.body) {
    lines.push(note.body);
    lines.push('');
  }
  
  if (note.links.size > 0) {
    lines.push('## Links');
    const sortedLinks = Array.from(note.links)
      .filter(lnk => lnk !== note.parentLink)
      .sort();
    sortedLinks.forEach(lnk => {
      lines.push(`- [[${lnk}]]`);
    });
    lines.push('');
  }
  
  if (note.parentLink) {
    lines.push(`up:: [[${note.parentLink}]]`);
  }
  
  return lines.join('\n');
}

export function mergeObsidianNote(
  existing: ObsidianNote,
  updateContent: string,
  incomingLinks: string[],
  today: string
): ObsidianNote {
  let cleanUpdate = updateContent.replace(/\r\n/g, '\n').trim();
  
  // Strip starting title matching "# Title"
  cleanUpdate = cleanUpdate.replace(/^#\s+.*$/m, '').trim();
  
  // Strip links section
  const linksHeaderIdx = cleanUpdate.indexOf('## Links');
  if (linksHeaderIdx !== -1) {
    cleanUpdate = cleanUpdate.substring(0, linksHeaderIdx).trim();
  }
  
  // Strip up:: line
  cleanUpdate = cleanUpdate.replace(/^up::\s*.*$/gm, '').trim();
  
  // Merge body
  let mergedBody = existing.body;
  if (cleanUpdate) {
    if (!existing.body.includes(cleanUpdate)) {
      if (mergedBody) {
        mergedBody += `\n\n### Updated on ${today}\n${cleanUpdate}`;
      } else {
        mergedBody = cleanUpdate;
      }
    }
  }
  
  // Merge links
  const mergedLinks = new Set(existing.links);
  incomingLinks.forEach(lnk => {
    let cleanLnk = lnk.trim();
    if (cleanLnk.startsWith('[[') && cleanLnk.endsWith(']]')) {
      cleanLnk = cleanLnk.slice(2, -2).trim();
    }
    if (cleanLnk) {
      mergedLinks.add(cleanLnk);
    }
  });
  
  if (existing.parentLink) {
    mergedLinks.delete(existing.parentLink);
  }
  
  return {
    frontmatter: existing.frontmatter,
    title: existing.title,
    body: mergedBody,
    links: mergedLinks,
    parentLink: existing.parentLink
  };
}

export const rememberTool = tool({
  description: 'Save or update a note in the Obsidian Knowledge Graph with links to other notes.',
  inputSchema: z.object({
    folder: z.enum(['Projects', 'Entities', 'Sessions', 'Learning']).describe('Subfolder category in the vault.'),
    title: z.string().describe('The title of the note (matches filename).'),
    content: z.string().describe('The body content of the note in Markdown.'),
    links: z.array(z.string()).describe('List of related notes to link using wikilink format, e.g. ["Projects/myapp", "Entities/auth"].')
  }),
  execute: async ({ folder, title, content, links }) => {
    const sessionId = sessionLocalStorage.getStore()?.sessionId || 'default';
    try {
      if (await isKillSwitchTriggered()) {
        return 'Error: Action blocked by kill switch.';
      }
      
      const vaultPath = await getVaultPath();
      const folderPath = path.join(vaultPath, folder);
      await fs.mkdir(folderPath, { recursive: true });
      
      const safeTitle = sanitizeFilename(title);
      const filePath = path.join(folderPath, `${safeTitle}.md`);
      
      const taint = getSessionTaint(sessionId);
      
      if (taint.isTainted) {
        const approved = await requestApproval('remember', {
          folder,
          title,
          tainted: true,
          reasons: taint.reasons,
          contentPreview: content.substring(0, 100)
        });
        await logAudit(sessionId, 'remember_approval', { title, approved, tainted: true });
        if (!approved) {
          return 'Error: Action denied by user (tainted context memory-write).';
        }
      }
      
      let existingContent = '';
      let isNew = true;
      
      try {
        existingContent = await fs.readFile(filePath, 'utf8');
        isNew = false;
      } catch (err: any) {
        if (err.code !== 'ENOENT') throw err;
      }
      
      const today = new Date().toISOString().split('T')[0];
      const typeSingular = folder.toLowerCase().replace(/s$/, '');
      const tags = [typeSingular];
      if (taint.isTainted) {
        tags.push('untrusted');
      }
      
      if (isNew) {
        const frontmatter = {
          note_type: typeSingular,
          created: today,
          tags
        };
        
        let cleanContent = content.replace(/\r\n/g, '\n').trim();
        cleanContent = cleanContent.replace(/^#\s+.*$/m, '').trim();
        const linksIdx = cleanContent.indexOf('## Links');
        if (linksIdx !== -1) {
          cleanContent = cleanContent.substring(0, linksIdx).trim();
        }
        cleanContent = cleanContent.replace(/^up::\s*.*$/gm, '').trim();
        
        const cleanLinks = new Set<string>();
        links.forEach(lnk => {
          let cleanLnk = lnk.trim();
          if (cleanLnk.startsWith('[[') && cleanLnk.endsWith(']]')) {
            cleanLnk = cleanLnk.slice(2, -2).trim();
          }
          if (cleanLnk) {
            cleanLinks.add(cleanLnk);
          }
        });
        
        const parentLink = `${folder}/_Index`;
        cleanLinks.delete(parentLink);
        
        const newNote: ObsidianNote = {
          frontmatter,
          title,
          body: cleanContent,
          links: cleanLinks,
          parentLink
        };
        
        const fileData = serializeObsidianNote(newNote);
        await fs.writeFile(filePath, fileData, 'utf8');
        await logAudit(sessionId, 'remember_success', { path: `${folder}/${safeTitle}.md`, isNew: true, tainted: taint.isTainted });
        return `Successfully created new note: ${folder}/${safeTitle}.md${taint.isTainted ? ' (marked untrusted)' : ''}`;
      } else {
        const existingNote = parseObsidianNote(existingContent, title);
        
        const existingTags = Array.isArray(existingNote.frontmatter.tags) ? existingNote.frontmatter.tags : [];
        const mergedTags = Array.from(new Set([...existingTags, ...tags]));
        existingNote.frontmatter.tags = mergedTags;
        existingNote.frontmatter.updated = today;
        
        const mergedNote = mergeObsidianNote(existingNote, content, links, today);
        const fileData = serializeObsidianNote(mergedNote);
        
        await fs.writeFile(filePath, fileData, 'utf8');
        await logAudit(sessionId, 'remember_success', { path: `${folder}/${safeTitle}.md`, isNew: false, tainted: taint.isTainted });
        return `Successfully merged note: ${folder}/${safeTitle}.md${taint.isTainted ? ' (marked untrusted)' : ''}`;
      }
    } catch (err: any) {
      return `Error in remember tool: ${err.message}`;
    }
  }
});

export const recallTool = tool({
  description: 'Search for existing knowledge notes in the Obsidian Vault by query string.',
  inputSchema: z.object({
    query: z.string().describe('Keyword or title to search inside the vault.')
  }),
  execute: async ({ query }) => {
    const sessionId = sessionLocalStorage.getStore()?.sessionId || 'default';
    try {
      if (await isKillSwitchTriggered()) {
        return 'Error: Action blocked by kill switch.';
      }
      
      const vaultPath = await getVaultPath();
      const files = await getVaultFiles(vaultPath);
      
      const lowercaseQuery = query.toLowerCase();
      const matches: Array<{ path: string; title: string; score: number; content: string; untrusted: boolean }> = [];
      
      for (const file of files) {
        const relativePath = path.relative(vaultPath, file).replace(/\\/g, '/');
        const filename = path.basename(file, '.md');
        const content = await fs.readFile(file, 'utf8');
        
        let score = 0;
        if (filename.toLowerCase().includes(lowercaseQuery)) {
          score += 10;
        }
        if (content.toLowerCase().includes(lowercaseQuery)) {
          score += 5;
        }
        
        if (score > 0) {
          const { frontmatter } = parseNote(content);
          const isUntrusted = Array.isArray(frontmatter.tags) && frontmatter.tags.includes('untrusted');
          
          matches.push({
            path: relativePath,
            title: filename,
            score,
            content,
            untrusted: isUntrusted
          });
        }
      }
      
      await logAudit(sessionId, 'recall', { query, matchesCount: matches.length });
      
      if (matches.length === 0) {
        return `No matching knowledge notes found in the vault for query: '${query}'.`;
      }
      
      matches.sort((a, b) => b.score - a.score);
      
      const surfaced = matches.slice(0, 5);
      const resultsText = surfaced.map(m => {
        const contentPreview = m.content.length > 1000
          ? m.content.substring(0, 1000) + '\n\n[...content truncated]'
          : m.content;

        const trustPrefix = m.untrusted
          ? `⚠️ [WARNING: UNTRUSTED/QUARANTINED NOTE]\n`
          : `✅ [VERIFIED NOTE]\n`;

        return `--- Note: ${m.path} ---\n${trustPrefix}${contentPreview}\n`;
      }).join('\n');

      // Vault notes are persistent memory replayed back into the model — treat as
      // external DATA (§9.4) and watch for memory poisoning (§9.7): scan for injection
      // patterns, and taint outright if a quarantined (untrusted) note was surfaced.
      scanAndTaint(sessionId, `recall:${query}`, resultsText);
      if (surfaced.some(m => m.untrusted)) {
        taintSession(sessionId, `recall surfaced quarantined (untrusted) note(s) for query "${query}"`);
      }

      return resultsText;
    } catch (err: any) {
      return `Error in recall tool: ${err.message}`;
    }
  }
});
