import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/service';
import { inngest } from '@/lib/inngest/client';

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { filePath, filename } = body;

    if (!filePath || !filename) {
      return NextResponse.json({ error: 'Missing filePath or filename' }, { status: 400 });
    }

    if (filePath.includes('..')) {
      return NextResponse.json({ error: 'Forbidden: Path traversal detected' }, { status: 403 });
    }

    if (!filePath.startsWith(`${user.id}/`)) {
      return NextResponse.json({ error: 'Forbidden: Invalid storage path' }, { status: 403 });
    }

    // Server-side file type guard — only allow the supported formats
    const ALLOWED_EXTENSIONS = new Set(['.docx', '.txt', '.csv', '.xlsx', '.xls']);
    const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
    const ext = '.' + (filename.split('.').pop()?.toLowerCase() ?? '');
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return NextResponse.json(
        { error: `Unsupported file type "${ext}". Accepted formats: ${[...ALLOWED_EXTENSIONS].join(', ')}` },
        { status: 415 },
      );
    }

    // Check file size via storage metadata before creating the DB record
    const { data: fileMeta } = await supabaseAdmin.storage
      .from('documents')
      .list(filePath.split('/').slice(0, -1).join('/'), {
        search: filePath.split('/').pop(),
      });
    const fileSize = fileMeta?.[0]?.metadata?.size ?? 0;
    if (fileSize > MAX_FILE_BYTES) {
      // Remove the oversized file from storage
      await supabaseAdmin.storage.from('documents').remove([filePath]);
      return NextResponse.json(
        { error: `File exceeds the 10 MB size limit (${(fileSize / 1024 / 1024).toFixed(1)} MB).` },
        { status: 413 },
      );
    }

    const { data: document, error: insertError } = await supabase
      .from('documents')
      .insert({
        user_id: user.id,
        filename: filename,
        storage_path: filePath,
        status: 'Processing',
      })
      .select()
      .single();

    if (insertError || !document) {
      console.error('Insert error:', insertError);
      return NextResponse.json({ error: 'Failed to create document record' }, { status: 500 });
    }

    try {
      await inngest.send({
        // Idempotency key — prevents double-processing if the same documentId
        // is sent more than once (e.g. accidental double upload or retry).
        id: `doc-process-${document.id}`,
        name: 'document.process',
        data: {
          documentId: document.id,
          filePath,
          userId: user.id,
          filename: document.filename,
        },
      });
    } catch (inngestErr: any) {
      console.error('Inngest send failed:', inngestErr?.message, inngestErr?.status, JSON.stringify(inngestErr));
      // Mark the document as Failed so the user isn't stuck on "Processing"
      await supabaseAdmin
        .from('documents')
        .update({ status: 'Failed', processing_step: null })
        .eq('id', document.id);
      return NextResponse.json(
        { error: `Processing queue error: ${inngestErr?.message ?? 'inngest.send failed'}` },
        { status: 502 }
      );
    }

    return NextResponse.json({ success: true, document });
  } catch (err: any) {
    console.error('Upload API error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
