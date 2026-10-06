seen = set()
for num in nums:
    if num in seen:
        return True
    else:
        seen.add(num)
