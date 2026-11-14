// Bounded SOCKS5 negotiation for update HTTPS requests only.
import net from 'node:net';
export async function socksTunnel(proxy, host, port, signal) {
  if(signal.aborted) throw Error('更新请求超时');
  let username,password;
  try { username=Buffer.from(decodeURIComponent(proxy.username));password=Buffer.from(decodeURIComponent(proxy.password)); }
  catch { throw Error('更新代理认证编码无效'); }
  const auth=username.length>0 || password.length>0;
  const domain=Buffer.from(host);
  if(domain.length<1 || domain.length>255 || username.length>255 || password.length>255 || (auth && !username.length)) throw Error('更新代理认证或目标长度无效');
  const socket=net.connect({host:proxy.hostname.replace(/^\[|\]$/g,''),port:Number(proxy.port)||1080});
  let buffer=Buffer.alloc(0),failure,waiting;
  const fail=error=>{failure=error;waiting?.();};
  const data=chunk=>{buffer=Buffer.concat([buffer,chunk]);if(buffer.length>1024)fail(Error('SOCKS5 握手响应过大'));else waiting?.();};
  const closed=()=>fail(Error('SOCKS5 握手连接提前关闭'));
  const aborted=()=>fail(Error('更新请求超时'));
  socket.on('data',data);socket.on('error',fail);socket.on('end',closed);socket.on('close',closed);
  signal.addEventListener('abort',aborted,{once:true});
  const read=async size=>{
    while(buffer.length<size && !failure) await new Promise(resolve=>{waiting=resolve;});
    waiting=null;if(failure)throw failure;
    const result=buffer.subarray(0,size);buffer=buffer.subarray(size);return result;
  };
  try {
    socket.write(Buffer.from(auth?[5,2,0,2]:[5,1,0]));
    const method=await read(2);
    if(method[0]!==5 || ![0,...(auth?[2]:[])].includes(method[1])) throw Error('SOCKS5 认证方式不受支持');
    if(method[1]===2) {
      socket.write(Buffer.concat([Buffer.from([1,username.length]),username,Buffer.from([password.length]),password]));
      const response=await read(2);
      if(response[0]!==1 || response[1]!==0) throw Error('SOCKS5 代理认证失败');
    }
    const targetPort=Buffer.alloc(2);targetPort.writeUInt16BE(Number(port)||443);
    socket.write(Buffer.concat([Buffer.from([5,1,0,3,domain.length]),domain,targetPort]));
    const head=await read(4);
    if(head[0]!==5 || head[1]!==0 || head[2]!==0) throw Error('SOCKS5 代理连接失败');
    if(head[3]===1) await read(6);
    else if(head[3]===4) await read(18);
    else if(head[3]===3) { const length=(await read(1))[0];await read(length+2); }
    else throw Error('SOCKS5 响应地址无效');
    socket.pause();
    if(buffer.length) socket.unshift(buffer);
    return socket;
  } catch(error) {socket.destroy();throw error;}
  finally {
    waiting=null;socket.off('data',data);socket.off('error',fail);socket.off('end',closed);socket.off('close',closed);
    signal.removeEventListener('abort',aborted);
  }
}
