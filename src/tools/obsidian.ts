import * as fs from 'fs/promises';
import * as path from 'path';
import { tool } from 'ai';
import { z } from 'zod';
import { isKillSwitchTriggered, logAudit } from '../core/audit';
import { sessionLocalStorage } from '../core/session';
import { getSessionTaint } from '../core/taint';
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
      
      // If session is tainted, remember requires explicit user approval
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
      
      // Format incoming links as wikilinks
      const incomingWikilinks = links.map(lnk => {
        const cleanLink = lnk.startsWith('[[') && lnk.endsWith(']]') ? lnk.slice(2, -2) : lnk;
        return `[[${cleanLink}]]`;
      });
      
      const tags = [typeSingular];
      if (taint.isTainted) {
        tags.push('untrusted'); // Quarantine tag
      }
      
      if (isNew) {
        // Create new note
        const frontmatter = {
          note_type: typeSingular,
          created: today,
          tags
        };
        
        const noteBody = [
          `# ${title}`,
          '',
          content,
          '',
          '## Links',
          ...incomingWikilinks.map(wl => `- ${wl}`),
          '',
          `up:: [[${folder}/_Index]]`
        ].join('\n');
        
        const fileData = `${stringifyFrontmatter(frontmatter)}\n${noteBody}`;
        await fs.writeFile(filePath, fileData, 'utf8');
        await logAudit(sessionId, 'remember_success', { path: `${folder}/${safeTitle}.md`, isNew: true, tainted: taint.isTainted });
        return `Successfully created new note: ${folder}/${safeTitle}.md${taint.isTainted ? ' (marked untrusted)' : ''}`;
      } else {
        // Merge with existing note
        const { frontmatter, body } = parseNote(existingContent);
        
        // Merge tags
        const existingTags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];
        const mergedTags = Array.from(new Set([...existingTags, ...tags]));
        frontmatter.tags = mergedTags;
        frontmatter.updated = today;
        
        // Merge content: append new content section
        const mergedBody = body.trim() + `\n\n### Updated on ${today}\n${content}`;
        
        // Extract existing wikilinks
        const bodyWikilinks: string[] = [];
        const linkRegex = /\[\[(.*?)\]\]/g;
        let match;
        while ((match = linkRegex.exec(existingContent)) !== null) {
          bodyWikilinks.push(`[[${match[1]}]]`);
        }
        
        const mergedWikilinks = Array.from(new Set([...bodyWikilinks, ...incomingWikilinks]));
        
        const bodyWithoutLinks = mergedBody
          .replace(/## Links[\s\S]*?(?=up::|$)/g, '')
          .replace(/up::[\s\S]*$/g, '')
          .trim();
          
        const noteBody = [
          bodyWithoutLinks,
          '',
          '## Links',
          ...mergedWikilinks.map(wl => `- ${wl}`),
          '',
          `up:: [[${folder}/_Index]]`
        ].join('\n');
        
        const fileData = `${stringifyFrontmatter(frontmatter)}\n${noteBody}`;
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
      
      const resultsText = matches.slice(0, 5).map(m => {
        const contentPreview = m.content.length > 1000 
          ? m.content.substring(0, 1000) + '\n\n[...content truncated]' 
          : m.content;
          
        const trustPrefix = m.untrusted 
          ? `⚠️ [WARNING: UNTRUSTED/QUARANTINED NOTE]\n`
          : `✅ [VERIFIED NOTE]\n`;
          
        return `--- Note: ${m.path} ---\n${trustPrefix}${contentPreview}\n`;
      }).join('\n');
      
      return resultsText;
    } catch (err: any) {
      return `Error in recall tool: ${err.message}`;
    }
  }
});
