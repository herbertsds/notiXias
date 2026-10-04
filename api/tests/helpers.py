def item(tweet_id, author="conta_a", reposter=None):
    return {"tweet_id": str(tweet_id), "author": author, "reposter": reposter, "kind": "repost" if reposter else "post"}


def append(client, newest_first, anchor_found=True, batch_id=None):
    body = {"items": newest_first, "anchor_found": anchor_found}
    if batch_id:
        body["batch_id"] = batch_id
    r = client.post("/api/v1/queue/append", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def queue(client, **params):
    r = client.get("/api/v1/queue", params={"limit": 100, **params})
    assert r.status_code == 200, r.text
    return r.json()["items"]


def tweet_ids(entries):
    return [e["tweet_id"] for e in entries]


def seed(client, n=5, author="conta_a"):
    """Cria n entradas com tweet_id 101..100+n; seq 1..n (101 é a mais antiga)."""
    newest_first = [item(100 + i, author) for i in range(n, 0, -1)]
    append(client, newest_first)
    return queue(client)
