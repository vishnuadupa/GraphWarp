import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

/**
 * POST /api/conversations/[id]/messages
 * Body: { role, content, suggestions? }
 * Persists a message and bumps conversation.updated_at (for recency sort).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Verify conversation belongs to user
  const { data: conv } = await supabase
    .from('conversations')
    .select('id, title')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();

  if (!conv) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { role, content, suggestions } = await req.json();

  const [msgRes] = await Promise.all([
    supabase
      .from('conversation_messages')
      .insert({ conversation_id: id, role, content, suggestions: suggestions ?? null })
      .select()
      .single(),
    // Bump updated_at so conversation surfaces at the top of the list
    supabase
      .from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', id),
  ]);

  if (msgRes.error) return NextResponse.json({ error: msgRes.error.message }, { status: 500 });
  return NextResponse.json({ message: msgRes.data });
}
