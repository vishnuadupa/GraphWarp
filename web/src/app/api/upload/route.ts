import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { inngest } from '@/lib/inngest/client';

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { fileUrl, filename } = body;

    if (!fileUrl || !filename) {
      return NextResponse.json({ error: 'Missing fileUrl or filename' }, { status: 400 });
    }

    const { data: document, error: insertError } = await supabase
      .from('documents')
      .insert({
        user_id: user.id,
        filename: filename,
        storage_path: fileUrl,
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
        fileUrl,
        userId: user.id
      }
    });

    return NextResponse.json({ success: true, document });
  } catch (err: any) {
    console.error('Upload API error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
