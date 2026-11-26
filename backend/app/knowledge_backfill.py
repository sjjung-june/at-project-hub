"""Run once after migration to index existing immutable TXT/CSV attachments."""
import argparse
import json
from hashlib import sha256
from pathlib import Path
from uuid import UUID
from .config import Settings
from .db import make_pool
from .document_index import MAX_BYTES,index_document


def backfill(pool,root,limit=200):
    counts={'indexed':0,'unsupported':0,'too_large':0,'unavailable':0}
    with pool.connection() as conn:
        rows=conn.execute('SELECT a.* FROM attachments a LEFT JOIN knowledge_documents k ON a.id=k.attachment_id WHERE k.attachment_id IS NULL ORDER BY a.id LIMIT %s',[limit]).fetchall()
        for row in rows:
            try:key=str(UUID(row['storage_key']))
            except (ValueError,TypeError):counts['unavailable']+=1;continue
            path=Path(root)/key
            if not path.is_file():counts['unavailable']+=1;continue
            if Path(row['filename']).suffix.lower() in ('.txt','.csv'):
                if row['size_bytes']>MAX_BYTES:
                    value=index_document(conn,row['id'],row['project_id'],row['filename'],row['sha256'],b'x'*(MAX_BYTES+1))
                else:
                    with path.open('rb') as stream:data=stream.read(MAX_BYTES+1)
                    if sha256(data).hexdigest()!=row['sha256']:counts['unavailable']+=1;continue
                    value=index_document(conn,row['id'],row['project_id'],row['filename'],row['sha256'],data)
            else:value=index_document(conn,row['id'],row['project_id'],row['filename'],row['sha256'],b'')
            counts['indexed' if value['state']=='ready' else value['state']]+=1
    return counts


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--limit',type=int,default=200);args=parser.parse_args()
    if not 1<=args.limit<=2000:parser.error('limit must be 1..2000')
    settings=Settings();pool=make_pool(settings.database_url.get_secret_value())
    if pool is None:raise SystemExit('DATABASE_URL is required')
    with pool:print(json.dumps(backfill(pool,settings.attachment_dir,args.limit)))
