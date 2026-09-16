from pathlib import Path


def test_result_preview_locates_the_node_in_the_graph_that_ran():
    """成片预览只能挂到**发起运行**的那个工作流里，不能挂进"当前打开"的那个。

    踩过（用户报的）：用音频跑，视频回来时人已经切到别的工作流，预览就挂到那边去了。
    根因是 ComfyUI 前端按 node id 在「当前活动工作流」里找节点——`executed` 事件走
    `getNodeByExecutionId(this.rootGraph, …)`；`onExecuted` 也是同一套查找，所以连
    `onExecuted` 都不能依赖。而 node id 在不同工作流之间会重号。

    所以我们的前端必须自己监听 `executed`，用**发起运行那一刻记下的图**定位节点。
    这条断言盯住三件事：别用 app.graph / app.rootGraph 找节点、要记下运行中的图、要自己接
    `executed` 事件。
    """
    source = (Path(__file__).resolve().parents[1] / "web" / "result_preview.js").read_text(
        encoding="utf-8"
    )
    # 注释里可以解释这条规矩，所以只查代码。
    code = "\n".join(line.split("//")[0] for line in source.splitlines())

    assert "runningGraph" in code, "要记下发起运行的那个图，不能每次现取当前标签"
    assert "execution_start" in code, "运行开始时要记下当时的图"
    assert "executed" in code, "要自己接 executed 事件，不能等前端的 onExecuted"
    # `app.graph` 只在没有 runningGraph 时兜底，且必须同时有 runningGraph——单独用它就是那个 bug。
    assert "runningGraph ?? app.graph" in code or "runningGraph || app.graph" in code, (
        'app.graph 只能作为 runningGraph 缺失时的兜底'
    )
