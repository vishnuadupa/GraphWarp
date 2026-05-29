import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/service';
import { inngest } from '@/lib/inngest/client';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

export const runtime = "nodejs";

const MAX_DOCS_PER_USER = 5;

const redis = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  : null;

const ratelimit = redis
  ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(2, '1 h'), analytics: true })
  : null;

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // ── Rate limit: 2 uploads per hour ──────────────────────────────────────
    if (ratelimit) {
      const { success } = await ratelimit.limit(`upload_${user.id}`);
      if (!success) {
        return NextResponse.json(
          { error: 'Upload limit reached (2 files per hour). Please try again later.' },
          { status: 429 },
        );
      }
    }

    // ── Document cap: max 5 per user ─────────────────────────────────────────
    const { count } = await supabaseAdmin
      .from('documents')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id);

    if ((count ?? 0) >= MAX_DOCS_PER_USER) {
      return NextResponse.json(
        { error: `Document limit reached (${MAX_DOCS_PER_USER} files maximum). Delete an existing document to upload a new one.` },
        { status: 403 },
      );
    }

    const body = await request.json().catch(() => ({}));
    if (typeof body !== 'object' || body === null) {
      return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
    }
    const { filePath, filename } = body;
    if (typeof filePath !== 'string' || typeof filename !== 'string' || !filePath || !filename) {
      return NextResponse.json({ error: 'Missing or invalid filePath/filename' }, { status: 400 });
    }
    if (!filePath.startsWith(`${user.id}/`)) {
      return NextResponse.json({ error: 'Forbidden: Invalid storage path' }, { status: 403 });
    }

    // ── File type guard ──────────────────────────────────────────────────────
    const ALLOWED_EXTENSIONS = new Set(['.docx', '.txt', '.csv', '.xlsx', '.xls', '.pdf']);
    const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB
    const ext = '.' + (filename.split('.').pop()?.toLowerCase() ?? '');
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return NextResponse.json(
        { error: `Unsupported file type "${ext}". Accepted: ${[...ALLOWED_EXTENSIONS].join(', ')}` },
        { status: 415 },
      );
    }

    // ── File size guard ──────────────────────────────────────────────────────
    const { data: fileMeta } = await supabaseAdmin.storage
      .from('documents')
      .list(filePath.split('/').slice(0, -1).join('/'), { search: filePath.split('/').pop() });
    const fileSize = fileMeta?.[0]?.metadata?.size ?? 0;
    if (fileSize === 0) {
      await supabaseAdmin.storage.from('documents').remove([filePath]);
      return NextResponse.json({ error: 'Uploaded file is empty (0 bytes).' }, { status: 422 });
    }
    if (fileSize > MAX_FILE_BYTES) {
      await supabaseAdmin.storage.from('documents').remove([filePath]);
      return NextResponse.json(
        { error: `File exceeds the 2 MB limit (${(fileSize / 1024 / 1024).toFixed(1)} MB uploaded). Please compress or split the file.` },
        { status: 413 },
      );
    }

    // ── Create document record ───────────────────────────────────────────────
    const { data: document, error: insertError } = await supabase
      .from('documents')
      .insert({ user_id: user.id, filename, storage_path: filePath, status: 'Processing' })
      .select()
      .single();

    if (insertError || !document) {
      console.error('Insert error:', insertError);
      return NextResponse.json({ error: 'Failed to create document record' }, { status: 500 });
    }

    // ── Enqueue Inngest job ──────────────────────────────────────────────────
    try {
      await inngest.send({
        id: `doc-process-${document.id}`,
        name: 'document.process',
        data: { documentId: document.id, filePath, userId: user.id, filename: document.filename },
      });
    } catch (inngestErr: any) {
      console.error('Inngest send failed:', inngestErr?.message);
      await supabaseAdmin.from('documents').update({ status: 'Failed', processing_step: null }).eq('id', document.id);
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 502 });
    }

    return NextResponse.json({ success: true, document });
  } catch (err: any) {
    console.error('Upload API error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
