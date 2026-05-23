UPDATE storage.buckets
SET file_size_limit = 1048576, -- 1MB strict limit
    allowed_mime_types = ARRAY['application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/png', 'image/jpeg', 'image/webp']
WHERE id = 'documents';
