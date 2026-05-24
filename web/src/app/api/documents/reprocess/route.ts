import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { driver } from '@/lib/neo4j/neo4j';
import { inngest } from '@/lib/inngest/client';

export const runtime = 'nodejs';

/**
 * POST /api/documents/reprocess
 * Body: { documentId: string }
 * Clears existing Neo4j data for the document and re-triggers extraction.
 */
export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { documentId } = await req.json();
    if (!documentId) return NextResponse.json({ error: 'documentId required' }, { status: 400 });

    // Fetch the document
    const { data: doc, error: docError } = await supabase
      .from('documents')
      .select('*')
      .eq('id', documentId)
      .eq('user_id', user.id)
      .single();

    if (docError || !doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    // 1. Remove existing Neo4j data for this file
    const session = driver.session();
    try {
      await session.executeWrite(async (tx) => {
        // Handles both old source_file (string) and new source_files (array) formats
        await tx.run(
          `MATCH ()-[r:RELATION {user_id: $uid}]->()
           WHERE r.source_file = $filename OR $filename IN coalesce(r.source_files, [])
           DELETE r`,
          { filename: doc.filename, uid: user.id }
        );
        // Clean up orphaned nodes
        await tx.run(
          'MATCH (n:Entity {user_id: $uid}) WHERE NOT (n)--() DELETE n',
          { uid: user.id }
        );
      });
    } finally {
      await session.close();
    }

    // 2. Reset document status
    await supabase
      .from('documents')
      .update({ status: 'Processing' })
      .eq('id', documentId);

    // 3. Re-fire Inngest event
    try {
      await inngest.send({
        name: 'document.process',
        data: {
          documentId:  doc.id,
          filePath:    doc.storage_path,
          userId:      user.id,
          filename:    doc.filename,
        },
      });
    } catch (inngestErr: any) {
      console.error('[reprocess] inngest.send FAILED:', inngestErr?.message);
      return NextResponse.json({ error: `Inngest send failed: ${inngestErr?.message}` }, { status: 502 });
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('Reprocess error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
