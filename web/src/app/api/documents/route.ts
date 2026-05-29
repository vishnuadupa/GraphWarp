import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/service';
import { driver } from '@/lib/neo4j/neo4j';

export async function GET(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data, error } = await supabase
      .from('documents')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return NextResponse.json({ documents: data });
  } catch (error: any) {
    console.error('Documents GET Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    if (typeof body !== 'object' || body === null) {
      return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
    }
    
    const documentId = body.documentId;
    if (typeof documentId !== 'string' || !documentId) {
      return NextResponse.json({ error: 'Document ID must be a valid string' }, { status: 400 });
    }

    // 1. Fetch the document to get the filename and storage_path
    const { data: doc, error: docError } = await supabase
      .from('documents')
      .select('*')
      .eq('id', documentId)
      .eq('user_id', user.id)
      .single();

    if (docError || !doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    // Prevent IDOR: Ensure the storage path actually belongs to the user
    if (doc.storage_path && !doc.storage_path.startsWith(`${user.id}/`)) {
      return NextResponse.json({ error: 'Invalid storage path' }, { status: 403 });
    }

    // 2. Delete the edges from Neo4j associated with this source_file
    const session = driver.session();
    try {
      await session.executeWrite(async (tx: any) => {
        await tx.run(
          `MATCH ()-[r:RELATION {user_id: $userId}]->()
           WHERE r.source_file = $filename
              OR $filename IN coalesce(r.source_files, [])
           DELETE r`,
          { filename: doc.filename, userId: user.id }
        );

        await tx.run(
          `MATCH (n:Entity {user_id: $userId})
           WHERE NOT (n)--()
           DELETE n`,
          { userId: user.id }
        );
      });
    } catch (graphError) {
      console.error('Neo4j Deletion Error:', graphError);
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    } finally {
      await session.close();
    }

    // 3. Delete from Supabase Storage using authenticated client (enforces Storage RLS)
    if (doc.storage_path) {
      const { error: storageError } = await supabase.storage
        .from('documents')
        .remove([doc.storage_path]);
      if (storageError) {
        console.error('Storage deletion error:', storageError);
      }
    }

    // 4. Delete from Postgres
    const { error: deleteError } = await supabase
      .from('documents')
      .delete()
      .eq('id', documentId)
      .eq('user_id', user.id);

    if (deleteError) {
      console.error('Document DB deletion error:', deleteError);
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }

    return NextResponse.json({ success: true });

  } catch (error: any) {
    console.error('Documents DELETE Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
