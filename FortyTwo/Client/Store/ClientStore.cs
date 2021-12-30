using System.Collections.Generic;
using FortyTwo.Shared.DTO;
using FortyTwo.Shared.Models.DTO;

namespace FortyTwo.Client.Store
{
    public class ClientStore : IClientStore
    {
        public List<Match> Matches { get; set; } = new List<Match>();
        public List<User> Users { get; set; } = new List<User>();
    }
}
