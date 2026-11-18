// 가려진 페이지의 타이머는 늘어지지만 전용 Worker 의 타이머는 그대로다 → 패널의 대기를 여기서 잰다.
onmessage = e => setTimeout(() => postMessage(e.data.id), e.data.ms);
