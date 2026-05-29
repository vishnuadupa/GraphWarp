import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { driver } from '@/lib/neo4j/neo4j';
import { inngest } from '@/lib/inngest/client';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

// Rate Limiting (50 requests per hour)
const redis = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  : null;

const ratelimit = redis
  ? new Ratelimit({
      redis: redis,
      limiter: Ratelimit.slidingWindow(50, '1 h'),
      analytics: true,
    })
  : null;

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

    const body = await req.json().catch(() => ({}));
    if (typeof body !== 'object' || body === null) {
      return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
    }

    if (ratelimit) {
      const { success } = await ratelimit.limit(`reprocess_${user.id}`);
      if (!success) {
        return NextResponse.json({ error: 'Rate limit exceeded (50 docs/hour). Please try again later.' }, { status: 429 });
      }
    }

    const documentId = body.documentId;
    if (typeof documentId !== 'string' || !documentId) {
      return NextResponse.json({ error: 'documentId must be a valid string' }, { status: 400 });
    }

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

    // Prevent IDOR: Ensure the storage path belongs to the user
    if (doc.storage_path && !doc.storage_path.startsWith(`${user.id}/`)) {
      return NextResponse.json({ error: 'Invalid storage path' }, { status: 403 });
    }

    // 1. Remove existing Neo4j data for this file
    const session = driver.session();
    try {
      await session.executeWrite(async (tx: any) => {
        await tx.run(
          `MATCH ()-[r:RELATION {user_id: $uid}]->()
           WHERE r.source_file = $filename OR $filename IN coalesce(r.source_files, [])
           DELETE r`,
          { filename: doc.filename, uid: user.id }
        );
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
      console.error('[reprocess] inngest.send FAILED:', inngestErr);
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 502 });
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('Reprocess error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
