using FortyTwo.Shared.DTO;
using System;
using System.Collections.Concurrent;

namespace FortyTwo.Client.Store
{
    public interface IClientStore
    {
        public ConcurrentDictionary<Guid, Match> Matches { get; set; }
        public ConcurrentDictionary<string, User> Users { get; set; }
    }
}
