from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse


class UploadBodyLimit:
    """Bound multipart data before spooling it to disk (also for chunked uploads)."""
    def __init__(self,app,max_bytes):
        self.app,self.max_bytes=app,max_bytes

    async def __call__(self,scope,receive,send):
        if scope['type']!='http' or scope.get('method')!='POST' or not scope.get('path','').endswith('/attachments'):
            return await self.app(scope,receive,send)
        headers=dict(scope.get('headers',[]))
        try:length=int(headers.get(b'content-length',b'0'))
        except ValueError:length=0
        if length>self.max_bytes:
            return await JSONResponse({'error':'첨부 요청 크기가 제한을 초과했습니다.'},status_code=413)(scope,receive,send)
        size=0
        async def bounded_receive():
            nonlocal size
            message=await receive()
            if message['type']=='http.request':
                size+=len(message.get('body',b''))
                if size>self.max_bytes:raise HTTPException(413,'첨부 요청 크기가 제한을 초과했습니다.')
            return message
        await self.app(scope,bounded_receive,send)
