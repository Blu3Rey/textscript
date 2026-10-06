# plus one for the header
total = a + 1
# ready means all inputs arrived
if ready:
    # the happy path
    go
# second chance
elif retry:
    wait
else:
    # give up
    stop
