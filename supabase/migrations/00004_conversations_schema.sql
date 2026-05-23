-- ==========================================
-- 4. Conversations and Conversation Messages Schema & RLS
-- ==========================================

-- Create Conversations Table
CREATE TABLE IF NOT EXISTS public.conversations (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    title text NOT NULL DEFAULT 'New Chat',
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL
);

-- Enable RLS for conversations
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

-- Strict RLS Policies for conversations
CREATE POLICY "Users can select their own conversations" 
ON public.conversations FOR SELECT 
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own conversations" 
ON public.conversations FOR INSERT 
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own conversations" 
ON public.conversations FOR UPDATE 
USING (auth.uid() = user_id) 
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own conversations" 
ON public.conversations FOR DELETE 
USING (auth.uid() = user_id);


-- Create Conversation Messages Table
CREATE TABLE IF NOT EXISTS public.conversation_messages (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
    role text NOT NULL,
    content text NOT NULL,
    suggestions jsonb, -- Stores array of string suggestions or null
    created_at timestamptz DEFAULT now() NOT NULL
);

-- Enable RLS for conversation_messages
ALTER TABLE public.conversation_messages ENABLE ROW LEVEL SECURITY;

-- Strict RLS Policies for conversation_messages (verifies parent conversation ownership)
CREATE POLICY "Users can select messages from their own conversations" 
ON public.conversation_messages FOR SELECT 
USING (
    EXISTS (
        SELECT 1 FROM public.conversations 
        WHERE conversations.id = conversation_messages.conversation_id 
          AND conversations.user_id = auth.uid()
    )
);

CREATE POLICY "Users can insert messages into their own conversations" 
ON public.conversation_messages FOR INSERT 
WITH CHECK (
    EXISTS (
        SELECT 1 FROM public.conversations 
        WHERE conversations.id = conversation_messages.conversation_id 
          AND conversations.user_id = auth.uid()
    )
);

CREATE POLICY "Users can update messages in their own conversations" 
ON public.conversation_messages FOR UPDATE 
USING (
    EXISTS (
        SELECT 1 FROM public.conversations 
        WHERE conversations.id = conversation_messages.conversation_id 
          AND conversations.user_id = auth.uid()
    )
)
WITH CHECK (
    EXISTS (
        SELECT 1 FROM public.conversations 
        WHERE conversations.id = conversation_messages.conversation_id 
          AND conversations.user_id = auth.uid()
    )
);

CREATE POLICY "Users can delete messages from their own conversations" 
ON public.conversation_messages FOR DELETE 
USING (
    EXISTS (
        SELECT 1 FROM public.conversations 
        WHERE conversations.id = conversation_messages.conversation_id 
          AND conversations.user_id = auth.uid()
    )
);
