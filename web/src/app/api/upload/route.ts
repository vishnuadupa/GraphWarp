import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
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

    if (!filePath.startsWith(`${user.id}/`)) {
      return NextResponse.json({ error: 'Forbidden: Invalid storage path' }, { status: 403 });
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

    await inngest.send({
      name: 'document.process',
      data: {
        documentId: document.id,
        filePath,
        userId: user.id,
        filename: document.filename
      }
    });

    return NextResponse.json({ success: true, document });
  } catch (err: any) {
    console.error('Upload API error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
