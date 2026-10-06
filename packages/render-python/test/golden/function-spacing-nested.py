def outer():
    count = 0

    def inner():
        return count

    return inner
