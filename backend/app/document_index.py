"""Bounded local extraction; document text is data, never an instruction."""
from pathlib import Path

MAX_BYTES=1024*1024
MAX_CHARS=120000


def extract(name,data):
    if Path(name).suffix.lower() not in ('.txt','.csv'):
        return {'state':'unsupported','text':'','truncated':False}
    if len(data)>MAX_BYTES:
        return {'state':'too_large','text':'','truncated':False}
    try:text=data.decode('utf-8-sig')
    except UnicodeDecodeError:return {'state':'unsupported','text':'','truncated':False}
    return {'state':'ready','text':text[:MAX_CHARS],'truncated':len(text)>MAX_CHARS}


def index_document(conn,aid,pid,name,digest,data):
    value=extract(name,data)
    conn.execute('INSERT INTO knowledge_documents(attachment_id,project_id,filename,content_hash,state,text_content,truncated) VALUES(%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(attachment_id) DO NOTHING',[aid,pid,name,digest,value['state'],value['text'],value['truncated']])
    return value


def evidence_rows(pid,revision,rows):
    sources=[]
    for row in rows:
        if row['state']!='ready':continue
        lines=row['text_content'].splitlines()
        for offset in range(0,len(lines),12):
            text='\n'.join(lines[offset:offset+12])
            for part,start in enumerate(range(0,len(text),4000)):
                quote=text[start:start+4000]
                if not quote.strip():continue
                suffix=f'.part.{part+1}' if len(text)>4000 else ''
                sources.append({'projectId':pid,'path':f"attachments.{row['attachment_id']}.lines.{offset+1}-{min(offset+12,len(lines))}{suffix}",'label':f"{row['filename']} · {offset+1}~{min(offset+12,len(lines))}행",'quote':quote,'revision':revision,'tab':'files','attachmentId':row['attachment_id'],'sourceHash':row['content_hash'],'superseded':bool(row.get('superseded')),'replacesId':row.get('replaces_id')})
    return sources
